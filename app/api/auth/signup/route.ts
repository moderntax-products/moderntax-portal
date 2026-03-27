/**
 * Self-Service Signup API
 * POST /api/auth/signup — New manager signs up with company info
 *
 * Flow:
 * 1. Validate email domain matches company website
 * 2. Find or create client record
 * 3. Create auth user + profile (role=manager)
 * 4. Sync to HubSpot (contact + company)
 * 5. Send welcome email
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { sendWelcomeEmail } from '@/lib/sendgrid';

function normalizeDomain(input: string): string {
  let domain = input.trim().toLowerCase();
  // Strip protocol
  domain = domain.replace(/^https?:\/\//, '');
  // Strip www.
  domain = domain.replace(/^www\./, '');
  // Strip trailing slash/path
  domain = domain.split('/')[0];
  return domain;
}

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 50);
}

async function syncToHubSpot(data: {
  email: string;
  firstName: string;
  lastName: string;
  title: string;
  companyName: string;
  companyDomain: string;
}) {
  try {
    const hubspotApiKey = process.env.HUBSPOT_API_KEY;
    if (!hubspotApiKey) {
      console.log('[signup] No HUBSPOT_API_KEY configured, skipping HubSpot sync');
      return;
    }

    // Create or update contact
    const contactRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${hubspotApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        properties: {
          email: data.email,
          firstname: data.firstName,
          lastname: data.lastName,
          jobtitle: data.title,
          company: data.companyName,
          hs_lead_status: 'NEW',
          lifecyclestage: 'lead',
        },
      }),
    });

    if (contactRes.status === 409) {
      // Contact already exists — update instead
      console.log('[signup] HubSpot contact already exists, updating');
      const existing = await contactRes.json();
      const contactId = existing?.message?.match(/ID: (\d+)/)?.[1];
      if (contactId) {
        await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${hubspotApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            properties: {
              jobtitle: data.title,
              company: data.companyName,
            },
          }),
        });
      }
    } else if (!contactRes.ok) {
      console.error('[signup] HubSpot contact creation failed:', await contactRes.text());
    } else {
      console.log('[signup] HubSpot contact created');
    }

    // Search for existing company by domain
    const searchRes = await fetch('https://api.hubapi.com/crm/v3/objects/companies/search', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${hubspotApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filterGroups: [{
          filters: [{
            propertyName: 'domain',
            operator: 'EQ',
            value: data.companyDomain,
          }],
        }],
      }),
    });

    if (searchRes.ok) {
      const searchData = await searchRes.json();
      if (searchData.total === 0) {
        // Create company
        await fetch('https://api.hubapi.com/crm/v3/objects/companies', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${hubspotApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            properties: {
              name: data.companyName,
              domain: data.companyDomain,
            },
          }),
        });
        console.log('[signup] HubSpot company created');
      }
    }
  } catch (err) {
    console.error('[signup] HubSpot sync error:', err);
    // Don't fail signup if HubSpot sync fails
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { fullName, title, companyName, companyWebsite, email, password } = body;

    // Validate required fields
    if (!fullName?.trim()) return NextResponse.json({ error: 'Full name is required' }, { status: 400 });
    if (!title?.trim()) return NextResponse.json({ error: 'Title is required' }, { status: 400 });
    if (!companyName?.trim()) return NextResponse.json({ error: 'Company name is required' }, { status: 400 });
    if (!companyWebsite?.trim()) return NextResponse.json({ error: 'Company website is required' }, { status: 400 });
    if (!email?.trim()) return NextResponse.json({ error: 'Email is required' }, { status: 400 });
    if (!password || password.length < 8) return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 });

    // Normalize domains
    const companyDomain = normalizeDomain(companyWebsite);
    const emailDomain = email.trim().toLowerCase().split('@')[1];

    if (!emailDomain) {
      return NextResponse.json({ error: 'Invalid email address' }, { status: 400 });
    }

    // Domain match check
    if (emailDomain !== companyDomain) {
      return NextResponse.json({
        error: 'Email domain must match company website',
        details: `Your email domain (@${emailDomain}) does not match your company website (${companyDomain}). Please use a business email that matches your company domain.`,
      }, { status: 400 });
    }

    // Reject personal email domains
    const blockedDomains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com', 'protonmail.com', 'mail.com'];
    if (blockedDomains.includes(emailDomain)) {
      return NextResponse.json({
        error: 'Business email required',
        details: 'Please use a business email address associated with your company domain.',
      }, { status: 400 });
    }

    const admin = createAdminClient();

    // Check if email already registered
    const { data: existingUsers } = await admin.auth.admin.listUsers();
    const emailExists = existingUsers?.users?.some((u) => u.email?.toLowerCase() === email.trim().toLowerCase());
    if (emailExists) {
      return NextResponse.json({
        error: 'An account with this email already exists',
        details: 'If you forgot your password, use the "Forgot Password" link on the login page.',
      }, { status: 409 });
    }

    // Find or create client
    let clientId: string;

    const { data: existingClient } = await admin
      .from('clients')
      .select('id, name')
      .eq('domain', companyDomain)
      .single() as { data: { id: string; name: string } | null; error: any };

    if (existingClient) {
      clientId = existingClient.id;
    } else {
      // Create new client
      const slug = generateSlug(companyName);
      const { data: newClient, error: clientError } = await admin
        .from('clients')
        .insert({
          name: companyName.trim(),
          slug,
          domain: companyDomain,
          intake_methods: ['csv', 'pdf', 'manual'],
          free_trial: true,
        })
        .select('id')
        .single() as { data: { id: string } | null; error: any };

      if (clientError || !newClient) {
        console.error('[signup] Client creation error:', clientError);
        return NextResponse.json({ error: 'Failed to create organization' }, { status: 500 });
      }
      clientId = newClient.id;
    }

    // Create auth user
    const { data: authData, error: authError } = await admin.auth.admin.createUser({
      email: email.trim().toLowerCase(),
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName.trim() },
    });

    if (authError || !authData?.user) {
      console.error('[signup] Auth user creation error:', authError);
      return NextResponse.json({ error: 'Failed to create account', details: authError?.message }, { status: 500 });
    }

    // Update profile with role, client, and title
    const { error: profileError } = await admin
      .from('profiles')
      .update({
        full_name: fullName.trim(),
        role: 'manager',
        client_id: clientId,
        title: title.trim(),
      })
      .eq('id', authData.user.id);

    if (profileError) {
      console.error('[signup] Profile update error:', profileError);
    }

    // Parse name for HubSpot
    const nameParts = fullName.trim().split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    // Sync to HubSpot (async, don't block signup)
    syncToHubSpot({
      email: email.trim().toLowerCase(),
      firstName,
      lastName,
      title: title.trim(),
      companyName: companyName.trim(),
      companyDomain,
    });

    // Send welcome email
    try {
      await sendWelcomeEmail(
        email.trim().toLowerCase(),
        fullName.trim(),
        'manager',
        '', // no temp password — they set their own
        existingClient?.name || companyName.trim(),
      );
    } catch (emailErr) {
      console.error('[signup] Welcome email failed:', emailErr);
    }

    return NextResponse.json({
      success: true,
      message: 'Account created successfully',
    }, { status: 201 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[signup] Error:', msg);
    return NextResponse.json({ error: 'Internal server error', details: msg }, { status: 500 });
  }
}
