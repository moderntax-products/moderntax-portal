/**
 * Transcript Request Intake API
 * POST /api/intake/transcript
 *
 * Allows API partners (e.g. Clearfirm) to programmatically submit
 * tax transcript requests. These skip the 8821/HelloSign flow entirely
 * and go straight into the queue for expert assignment & IRS processing.
 *
 * Auth: x-api-key header validated against clients.api_key
 *
 * Each entity typically yields 8 transcripts:
 *   - 1 entity report
 *   - 3 tax return transcripts (one per year)
 *   - 4 payroll transcripts (one per quarter)
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import { sendAdminNewRequestNotification } from '@/lib/sendgrid';

interface EntityPayload {
  entity_name: string;
  tid: string;
  tid_kind?: 'EIN' | 'SSN';
  form_type?: '1040' | '1065' | '1120' | '1120S';
  years: string[];
  address?: string;
  city?: string;
  state?: string;
  zip_code?: string;
}

interface TranscriptIntakeBody {
  request_token: string;
  loan_number?: string;
  entities: EntityPayload[];
  notes?: string;
}

const VALID_FORM_TYPES = ['1040', '1065', '1120', '1120S'];

function formatTid(tid: string, kind: string): string {
  const digits = tid.replace(/\D/g, '');
  if (kind === 'SSN' && digits.length === 9) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
  }
  if (kind === 'EIN' && digits.length === 9) {
    return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  }
  return tid;
}

function normalizeFormType(form: string): string {
  const cleaned = form.replace(/[\s-]/g, '').toUpperCase();
  if (VALID_FORM_TYPES.includes(cleaned)) return cleaned;
  const stripped = cleaned.replace('FORM', '');
  if (VALID_FORM_TYPES.includes(stripped)) return stripped;
  return '1040';
}

export async function POST(request: NextRequest) {
  try {
    // --- Auth ---
    const apiKey = request.headers.get('x-api-key');
    if (!apiKey) {
      return NextResponse.json(
        { error: 'Missing x-api-key header' },
        { status: 401 }
      );
    }

    const supabase = createAdminClient();

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

    // --- Parse body ---
    const body: TranscriptIntakeBody = await request.json();

    // --- Validate ---
    if (!body.request_token?.trim()) {
      return NextResponse.json(
        { error: 'request_token is required' },
        { status: 400 }
      );
    }

    if (!body.entities || !Array.isArray(body.entities) || body.entities.length === 0) {
      return NextResponse.json(
        { error: 'entities array is required and must not be empty' },
        { status: 400 }
      );
    }

    // Validate each entity
    const validationErrors: string[] = [];
    body.entities.forEach((ent, idx) => {
      const prefix = `entities[${idx}]`;
      if (!ent.entity_name?.trim()) validationErrors.push(`${prefix}.entity_name is required`);
      if (!ent.tid?.trim()) validationErrors.push(`${prefix}.tid is required`);
      if (!ent.years || !Array.isArray(ent.years) || ent.years.length === 0) {
        validationErrors.push(`${prefix}.years array is required and must not be empty`);
      } else {
        ent.years.forEach((y, yi) => {
          if (!/^\d{4}$/.test(y)) validationErrors.push(`${prefix}.years[${yi}] must be a 4-digit year`);
        });
      }
      if (ent.form_type && !VALID_FORM_TYPES.includes(ent.form_type.replace(/[\s-]/g, '').toUpperCase())) {
        validationErrors.push(`${prefix}.form_type must be one of: ${VALID_FORM_TYPES.join(', ')}`);
      }
      if (ent.tid_kind && !['EIN', 'SSN'].includes(ent.tid_kind.toUpperCase())) {
        validationErrors.push(`${prefix}.tid_kind must be EIN or SSN`);
      }
    });

    if (validationErrors.length > 0) {
      return NextResponse.json(
        { error: 'Validation errors', details: validationErrors },
        { status: 400 }
      );
    }

    // --- Check duplicate request_token ---
    const { data: existing } = await supabase
      .from('requests')
      .select('id')
      .eq('external_request_token', body.request_token.trim())
      .maybeSingle();

    if (existing) {
      return NextResponse.json(
        { error: 'Duplicate request_token', existing_request_id: existing.id },
        { status: 409 }
      );
    }

    // --- Quota check ---
    if (client.api_request_limit) {
      const { count } = await supabase
        .from('requests')
        .select('id', { count: 'exact', head: true })
        .eq('client_id', client.id)
        .eq('intake_method', 'api');

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

    // --- Find admin profile for attribution ---
    const { data: adminProfile } = await supabase
      .from('profiles')
      .select('id')
      .eq('role', 'admin')
      .limit(1)
      .single();

    if (!adminProfile?.id) {
      return NextResponse.json(
        { error: 'No admin profile found for API request attribution' },
        { status: 500 }
      );
    }

    // --- Create request ---
    const loanNumber = body.loan_number?.trim() || body.request_token.trim();

    const { data: req, error: reqError } = await supabase
      .from('requests')
      .insert({
        client_id: client.id,
        requested_by: adminProfile.id,
        loan_number: loanNumber,
        intake_method: 'api',
        product_type: 'transcript',
        external_request_token: body.request_token.trim(),
        status: 'irs_queue', // Skip 8821 flow — go straight to queue
        notes: body.notes || `[API] Transcript request via ${client.name}`,
      })
      .select()
      .single();

    if (reqError || !req) {
      console.error('[transcript-intake] Request creation error:', reqError);
      return NextResponse.json(
        { error: 'Failed to create request', details: reqError?.message },
        { status: 500 }
      );
    }

    // --- Create entities ---
    const entityRows = body.entities.map((ent) => {
      const tidKind = ent.tid_kind?.toUpperCase() === 'SSN' ? 'SSN' : 'EIN';
      return {
        request_id: req.id,
        entity_name: ent.entity_name.trim(),
        tid: formatTid(ent.tid.trim(), tidKind),
        tid_kind: tidKind,
        form_type: normalizeFormType(ent.form_type || '1040'),
        years: ent.years,
        address: ent.address || null,
        city: ent.city || null,
        state: ent.state || null,
        zip_code: ent.zip_code || null,
        status: 'irs_queue', // Skip 8821 — ready for expert assignment
      };
    });

    const { data: createdEntities, error: entError } = await supabase
      .from('request_entities')
      .insert(entityRows)
      .select('id, entity_name, form_type, years, status');

    if (entError) {
      console.error('[transcript-intake] Entity creation error:', entError);
      return NextResponse.json(
        { error: 'Failed to create entities', details: entError?.message },
        { status: 500 }
      );
    }

    // --- Usage stats ---
    const { count: usedCount } = await supabase
      .from('requests')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', client.id)
      .eq('intake_method', 'api');

    const used = usedCount || 0;
    const remaining = client.api_request_limit
      ? client.api_request_limit - used
      : null;

    // --- Audit log ---
    await logAuditFromRequest(supabase, request, {
      action: 'transcript_request_received',
      userId: adminProfile.id,
      resourceType: 'request',
      resourceId: req.id,
      details: {
        client_name: client.name,
        client_slug: client.slug,
        request_token: body.request_token,
        entity_count: body.entities.length,
        entities: body.entities.map((e) => ({
          name: e.entity_name,
          form_type: e.form_type || '1040',
          years: e.years,
        })),
      },
    });

    // --- Notify admins (no email to signer — Clearfirm handles 8821 externally) ---
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
            loanNumber,
            body.entities.length,
            req.id
          );
        }
      }
    } catch (notifyErr) {
      console.error('[transcript-intake] Admin notification error:', notifyErr);
    }

    // --- Response ---
    return NextResponse.json({
      success: true,
      request_id: req.id,
      request_token: body.request_token,
      loan_number: loanNumber,
      status: 'irs_queue',
      entities: (createdEntities || []).map((e: any) => ({
        entity_id: e.id,
        entity_name: e.entity_name,
        form_type: e.form_type,
        years: e.years,
        status: e.status,
      })),
      usage: {
        used,
        remaining,
        limit: client.api_request_limit,
      },
    });
  } catch (err) {
    console.error('[transcript-intake] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Transcript intake failed' },
      { status: 500 }
    );
  }
}
