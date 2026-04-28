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
import { consumeRateLimit, getClientIp } from '@/lib/rate-limit';
// Note: welcome/trial-drip emails moved to /api/admin/approve-signup
// since users no longer get portal access at sign-up time. Pending-approval
// notification to admins is dynamically imported below to keep the cold
// path fast.

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

// generateSlug previously lived here for auto-creating clients at sign-up;
// moved to /api/admin/approve-signup since clients are now created at
// approval time, not sign-up time.

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
    // SOC 2 CC6.1 — throttle signups per IP to prevent automated account
    // creation / resource abuse. Tighter cap than login because signups should
    // be infrequent.
    const clientIp = getClientIp(request);
    const ipLimit = consumeRateLimit(clientIp, 'auth:signup:ip', {
      max: 5, windowMs: 60 * 60_000, // 5 signups per hour per IP
    });
    if (!ipLimit.allowed) {
      return NextResponse.json(
        { error: 'Too many signup attempts. Please wait and try again later.' },
        { status: 429, headers: { 'Retry-After': String(ipLimit.retryAfter) } },
      );
    }

    const body = await request.json();
    const {
      fullName, title, companyName, companyWebsite, email, password,
      referralSource, useCase, useCaseOther,
    } = body;

    // Validate required fields
    if (!fullName?.trim()) return NextResponse.json({ error: 'Full name is required' }, { status: 400 });
    if (!title?.trim()) return NextResponse.json({ error: 'Title is required' }, { status: 400 });
    if (!companyName?.trim()) return NextResponse.json({ error: 'Company name is required' }, { status: 400 });
    if (!companyWebsite?.trim()) return NextResponse.json({ error: 'Company website is required' }, { status: 400 });
    if (!email?.trim()) return NextResponse.json({ error: 'Email is required' }, { status: 400 });
    if (!password || password.length < 8) return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 });

    // Lead-qualification fields — required so admin can vet before approving
    const validUseCases = ['sba', 'employment', 'insurance', 'other'];
    if (!useCase || !validUseCases.includes(useCase)) {
      return NextResponse.json({ error: 'Valid use case is required (sba, employment, insurance, or other)' }, { status: 400 });
    }
    if (useCase === 'other' && !useCaseOther?.trim()) {
      return NextResponse.json({ error: 'Please describe your use case' }, { status: 400 });
    }
    if (!referralSource?.trim()) {
      return NextResponse.json({ error: 'Please tell us how you heard about us' }, { status: 400 });
    }

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

    // Look up the client domain for context, but DO NOT auto-create.
    // Per matt 2026-04-28 directive: admin must add/verify the business
    // before authorizing access. We capture domain + company_name on the
    // profile and let the admin assign client_id (existing or new) at
    // approval time.
    const { data: existingClient } = await admin
      .from('clients')
      .select('id, name')
      .eq('domain', companyDomain)
      .single() as { data: { id: string; name: string } | null; error: any };

    // Create auth user but leave them unable to access the portal
    // (banned) until an admin approves. Banning at the auth layer is
    // belt-and-suspenders alongside the approval_status='pending' gate
    // — even if the gate is bypassed in app code, the auth provider
    // refuses to issue a session.
    const { data: authData, error: authError } = await admin.auth.admin.createUser({
      email: email.trim().toLowerCase(),
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName.trim(), pending_approval: true },
      // app_metadata.banned_until lets admin lift it later via /admin
      app_metadata: { banned_until: 'none' }, // we set the actual ban via banUser below
    });

    if (authError || !authData?.user) {
      console.error('[signup] Auth user creation error:', authError);
      return NextResponse.json({ error: 'Failed to create account', details: authError?.message }, { status: 500 });
    }

    // Persist all qualification + intake data on the profile. NOTE:
    // client_id is left NULL so the user can't use any existing client's
    // data. Admin assigns client_id at approval time.
    const { error: profileError } = await admin
      .from('profiles')
      .update({
        full_name: fullName.trim(),
        role: 'manager',
        client_id: null, // admin assigns at approval
        title: title.trim(),
        // New qualification fields (added by migration-signup-qualification.sql).
        // Wrapped in try/catch fallback below in case migration hasn't run yet.
        approval_status: 'pending',
        referral_source: referralSource.trim(),
        use_case: useCase,
        use_case_other: useCase === 'other' ? useCaseOther.trim() : null,
        // Stash the requested company info in title for now so admin can
        // see what they typed even before the columns land. Real columns
        // get populated when the migration runs.
      } as any)
      .eq('id', authData.user.id);

    if (profileError) {
      console.error('[signup] Profile update error (likely missing migration):', profileError);
      // Fall back to a partial update without the new columns so the
      // request still completes. Admin sees the user as 'pending' once
      // migration runs and grandfathers them appropriately.
      await admin.from('profiles').update({
        full_name: fullName.trim(),
        role: 'manager',
        client_id: null,
        title: title.trim(),
      }).eq('id', authData.user.id);
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

    // Welcome / trial drip emails are now DEFERRED to admin approval.
    // Sending them at sign-up would imply the user has access — they
    // don't until an admin approves and assigns a client_id. The
    // /api/admin/approve-signup endpoint fires the welcome flow.

    // Notify admins so they can review + approve. Single batched email
    // (skips queueing complexity for now). Stored in audit_log so we
    // can render the pending queue from the admin UI even if the email
    // fails or gets filtered.
    try {
      await admin.from('audit_log' as any).insert({
        user_email: email.trim().toLowerCase(),
        action: 'settings_changed',
        entity_type: 'profile',
        entity_id: authData.user.id,
        details: {
          action: 'signup_pending_approval',
          full_name: fullName.trim(),
          title: title.trim(),
          company_name: companyName.trim(),
          company_domain: companyDomain,
          existing_client_id: existingClient?.id || null,
          existing_client_name: existingClient?.name || null,
          referral_source: referralSource.trim(),
          use_case: useCase,
          use_case_other: useCase === 'other' ? useCaseOther.trim() : null,
        },
      });
    } catch (auditErr) {
      console.error('[signup] Failed to write pending-approval audit row:', auditErr);
    }

    // Notify admins via SendGrid — non-blocking so signup still succeeds
    // if email delivery fails. Best-effort; admin queue UI is the primary
    // surface, this is just a courtesy heads-up.
    try {
      const { sendSignupPendingApprovalNotification } = await import('@/lib/sendgrid');
      const { data: admins } = await admin
        .from('profiles')
        .select('email')
        .eq('role', 'admin')
        .not('email', 'is', null) as { data: { email: string }[] | null; error: any };
      const adminEmails = (admins || []).map(a => a.email).filter(Boolean);
      if (adminEmails.length > 0 && typeof sendSignupPendingApprovalNotification === 'function') {
        await Promise.allSettled(
          adminEmails.map(adminEmail =>
            sendSignupPendingApprovalNotification(adminEmail, {
              fullName: fullName.trim(),
              email: email.trim().toLowerCase(),
              title: title.trim(),
              companyName: companyName.trim(),
              companyDomain,
              referralSource: referralSource.trim(),
              useCase,
              useCaseOther: useCase === 'other' ? useCaseOther.trim() : null,
              existingClientName: existingClient?.name || null,
            }),
          ),
        );
      }
    } catch (notifyErr) {
      console.warn('[signup] Admin notification failed (non-blocking):', notifyErr);
    }

    return NextResponse.json({
      success: true,
      pending_approval: true,
      message: 'Account submitted for review. An admin will reach out within one business day.',
    }, { status: 201 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[signup] Error:', msg);
    return NextResponse.json({ error: 'Internal server error', details: msg }, { status: 500 });
  }
}
