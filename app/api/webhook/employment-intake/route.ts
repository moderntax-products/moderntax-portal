/**
 * Employment Verification Intake Webhook
 * POST /api/webhook/employment-intake
 *
 * Called by external backend (api.moderntax.io) when Employer.com submits
 * a new employment/wage & income verification request.
 *
 * Auth: x-api-key header validated against clients.api_key
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import { sendAdminNewRequestNotification } from '@/lib/sendgrid';

interface EmploymentIntakeBody {
  request_token: string;
  employee_name: string;
  employee_ssn: string;
  employee_address?: {
    street?: string;
    city?: string;
    state?: string;
    zip?: string;
  };
  years: string[];
}

export async function POST(request: NextRequest) {
  try {
    const apiKey = request.headers.get('x-api-key');
    if (!apiKey) {
      return NextResponse.json(
        { error: 'Missing x-api-key header' },
        { status: 401 }
      );
    }

    const supabase = createAdminClient();

    // Look up client by API key
    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('id, name, slug, api_key, api_request_limit')
      .eq('api_key', apiKey)
      .single();

    if (clientError || !client) {
      return NextResponse.json(
        { error: 'Invalid API key' },
        { status: 401 }
      );
    }

    const body: EmploymentIntakeBody = await request.json();

    // Validate required fields
    if (!body.request_token) {
      return NextResponse.json(
        { error: 'request_token is required' },
        { status: 400 }
      );
    }
    if (!body.employee_name) {
      return NextResponse.json(
        { error: 'employee_name is required' },
        { status: 400 }
      );
    }
    if (!body.employee_ssn) {
      return NextResponse.json(
        { error: 'employee_ssn is required' },
        { status: 400 }
      );
    }
    if (!body.years || body.years.length === 0) {
      return NextResponse.json(
        { error: 'years array is required and must not be empty' },
        { status: 400 }
      );
    }

    // Check for duplicate request_token
    const { data: existingRequest } = await supabase
      .from('requests')
      .select('id')
      .eq('external_request_token', body.request_token)
      .maybeSingle();

    if (existingRequest) {
      return NextResponse.json(
        { error: 'Duplicate request_token', existing_request_id: existingRequest.id },
        { status: 409 }
      );
    }

    // Check API quota
    if (client.api_request_limit) {
      const { count } = await supabase
        .from('requests')
        .select('id', { count: 'exact', head: true })
        .eq('client_id', client.id)
        .eq('product_type', 'employment');

      const used = count || 0;
      if (used >= client.api_request_limit) {
        return NextResponse.json(
          {
            error: 'API request limit exceeded',
            usage: { used, limit: client.api_request_limit },
          },
          { status: 429 }
        );
      }
    }

    // Find or create a service account profile for API requests
    // Use the first admin as the requester for API-originated requests
    const { data: adminProfile } = await supabase
      .from('profiles')
      .select('id')
      .eq('role', 'admin')
      .limit(1)
      .single();

    const requestedBy = adminProfile?.id;
    if (!requestedBy) {
      return NextResponse.json(
        { error: 'No admin profile found for API request attribution' },
        { status: 500 }
      );
    }

    // Format SSN for storage — store full SSN so admin can populate 8821 forms
    const ssnDigits = body.employee_ssn.replace(/\D/g, '');
    const formattedSsn = ssnDigits.length === 9
      ? `${ssnDigits.slice(0, 3)}-${ssnDigits.slice(3, 5)}-${ssnDigits.slice(5)}`
      : body.employee_ssn;
    const ssnLast4 = ssnDigits.slice(-4);

    // Create request
    const { data: req, error: reqError } = await supabase
      .from('requests')
      .insert({
        client_id: client.id,
        requested_by: requestedBy,
        loan_number: body.request_token,
        intake_method: 'api',
        product_type: 'employment',
        external_request_token: body.request_token,
        status: 'submitted',
        notes: `[API] Employment verification for ${body.employee_name} via ${client.name}`,
      })
      .select()
      .single();

    if (reqError || !req) {
      console.error('Request creation error:', reqError);
      return NextResponse.json(
        { error: 'Failed to create request', details: reqError?.message || 'Unknown error', code: reqError?.code },
        { status: 500 }
      );
    }

    // Create entity
    const { data: entity, error: entError } = await supabase
      .from('request_entities')
      .insert({
        request_id: req.id,
        entity_name: body.employee_name,
        tid: formattedSsn,
        tid_kind: 'SSN',
        address: body.employee_address?.street || null,
        city: body.employee_address?.city || null,
        state: body.employee_address?.state || null,
        zip_code: body.employee_address?.zip || null,
        form_type: 'W2_INCOME',
        years: body.years,
        status: 'pending',
      })
      .select()
      .single();

    if (entError) {
      console.error('Entity creation error:', entError);
      return NextResponse.json(
        { error: 'Failed to create entity', details: entError?.message || 'Unknown error', code: entError?.code },
        { status: 500 }
      );
    }

    // Get usage stats
    const { count: usedCount } = await supabase
      .from('requests')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', client.id)
      .eq('product_type', 'employment');

    const used = usedCount || 0;
    const remaining = client.api_request_limit
      ? client.api_request_limit - used
      : null;

    // Audit log
    await logAuditFromRequest(supabase, request, {
      action: 'employment_request_received',
      userId: requestedBy,
      resourceType: 'request',
      resourceId: req.id,
      details: {
        client_name: client.name,
        client_slug: client.slug,
        request_token: body.request_token,
        employee_name: body.employee_name,
        ssn_last_4: ssnLast4,
        years: body.years,
        entity_id: entity?.id,
      },
    });

    // Notify admins
    try {
      const { data: admins } = await supabase
        .from('profiles')
        .select('email')
        .eq('role', 'admin');

      if (admins && admins.length > 0) {
        for (const admin of admins) {
          await sendAdminNewRequestNotification(
            admin.email,
            client.name,
            'api',
            client.name,
            body.request_token,
            1,
            req.id
          );
        }
      }
    } catch (notifyErr) {
      console.error('Admin notification error:', notifyErr);
    }

    return NextResponse.json({
      success: true,
      request_id: req.id,
      entity_id: entity?.id || null,
      request_token: body.request_token,
      usage: {
        used,
        remaining,
        limit: client.api_request_limit,
      },
    });
  } catch (err) {
    console.error('Employment intake error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Employment intake failed' },
      { status: 500 }
    );
  }
}
