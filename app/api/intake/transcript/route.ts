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
import { validateFormTypeMatchesTidKind, inferFormTypeFromTidKind } from '@/lib/form-type-validation';
import { sha256Hex, safeEqual } from '@/lib/auth-util';
import { checkOrderGate, buildOrderGateErrorBody } from '@/lib/order-gate';
import { parseJsonBodyOrRespond } from '@/lib/request-body';
import { autoFulfillRequestFromRecord } from '@/lib/auto-fulfill';

// Auto-fulfill-from-record can deliver several cached transcripts per entity
// via incremental webhooks inline — give the function headroom beyond default.
export const runtime = 'nodejs';
export const maxDuration = 60;

interface EntityPayload {
  entity_name: string;
  tid: string;
  tid_kind?: 'EIN' | 'SSN';
  form_type?: '1040' | '1065' | '1120' | '1120S' | '941';
  years: string[];
  address?: string;
  city?: string;
  state?: string;
  zip_code?: string;
  /**
   * Month (1-12) of the entity's fiscal year end. Omit or set to 12 for
   * calendar year. Only consulted for income-tax forms (1040/1065/1120/1120S);
   * Form 941 always uses calendar quarters regardless of FYE.
   *
   * Example for an entity with a Feb 28 FYE filing tax year 2024:
   *   { years: ["2024"], fiscal_year_end_month: 2 }
   * → expert pulls period ending 02-28-2025 (the FY ends the year AFTER
   *   the fiscal-year label in IRS convention).
   */
  fiscal_year_end_month?: number;
}

interface TranscriptIntakeBody {
  request_token: string;
  loan_number?: string;
  entities: EntityPayload[];
  notes?: string;
  /**
   * Optional loan-officer attribution (2026-05-29). When the API partner's
   * LOS knows which loan officer originated the request, pass the name and
   * email here. The dashboard's "Loan Officer" column + manager breakdown
   * table will use these instead of "Unknown" / the admin who provisioned
   * the API key. Free-text — does NOT need to match a ModernTax profile.
   */
  loan_officer_name?: string;
  loan_officer_email?: string;
}

const VALID_FORM_TYPES = ['1040', '1065', '1120', '1120S', '941'];

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
    // Lookup by SHA-256 hash + constant-time compare. The plaintext
    // clients.api_key column is being phased out. See
    // supabase/migration-api-key-hashing.sql.
    const apiKey = request.headers.get('x-api-key');
    if (!apiKey) {
      return NextResponse.json(
        { error: 'Missing x-api-key header' },
        { status: 401 }
      );
    }

    const supabase = createAdminClient();
    const presentedHash = sha256Hex(apiKey);

    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('id, name, slug, api_key_hash, api_request_limit')
      .eq('api_key_hash', presentedHash)
      .single() as { data: { id: string; name: string; slug: string; api_key_hash: string; api_request_limit: number | null } | null; error: any };

    if (clientError || !client || !safeEqual(client.api_key_hash, presentedHash)) {
      return NextResponse.json(
        { error: 'Invalid API key' },
        { status: 401 }
      );
    }

    // --- Parse body ---
    // SOC 2 CC7.2 — bounded JSON for partner intake. Largest legitimate
    // payload observed is ~3 entities * ~500 bytes each = ~2KB. 256KB cap
    // is the default and gives plenty of headroom while preventing DoS.
    const parsed = await parseJsonBodyOrRespond<TranscriptIntakeBody>(request);
    if (parsed instanceof NextResponse) return parsed;
    const body: TranscriptIntakeBody = parsed;

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
      // Form-type vs. tid_kind compatibility — reject e.g. EIN on 1040, SSN on 1120S.
      if (ent.form_type && ent.tid_kind) {
        const mismatch = validateFormTypeMatchesTidKind(ent.tid_kind, ent.form_type);
        if (mismatch) validationErrors.push(`${prefix}: ${mismatch}`);
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

    // Order gate: Mercury enrollment required (with sandbox + bypass exemptions).
    // Sandbox keys (Vine / Collective / Moxie) auto-pass via slug suffix;
    // Centerstone / Cal Statewide / Clearfirm pass via bypass_payment_paywall flag;
    // everyone else needs a Mercury customer record on file.
    const gate = await checkOrderGate(supabase, client.id);
    if (!gate.allowed) {
      return NextResponse.json(buildOrderGateErrorBody(gate), { status: gate.status ?? 402 });
    }

    // --- Create request ---
    const loanNumber = body.loan_number?.trim() || body.request_token.trim();

    // Loan-officer attribution from the API payload (optional). Trimmed
    // to strip accidental whitespace from LOS exports.
    const officerName = body.loan_officer_name?.trim() || null;
    const officerEmail = body.loan_officer_email?.trim().toLowerCase() || null;

    // Two-phase insert: try with the officer columns first. If they don't
    // exist yet (migration-external-loan-officer.sql not applied), retry
    // without them. Same pattern as source_request_id + add_ons.
    const reqInsertPayload: Record<string, unknown> = {
      client_id: client.id,
      requested_by: adminProfile.id,
      loan_number: loanNumber,
      intake_method: 'api',
      product_type: 'transcript',
      external_request_token: body.request_token.trim(),
      status: 'irs_queue', // Skip 8821 flow — go straight to queue
      notes: body.notes || `[API] Transcript request via ${client.name}${officerName ? ` (officer: ${officerName})` : ''}`,
      external_loan_officer_name: officerName,
      external_loan_officer_email: officerEmail,
    };
    let { data: req, error: reqError } = await (supabase
      .from('requests') as any)
      .insert(reqInsertPayload)
      .select()
      .single();
    if (reqError && /external_loan_officer|column .* does not exist|PGRST204/i.test(reqError?.message || '')) {
      console.warn('[transcript-intake] external_loan_officer_* columns missing — falling back without attribution. Paste supabase/migration-external-loan-officer.sql to enable.');
      delete reqInsertPayload.external_loan_officer_name;
      delete reqInsertPayload.external_loan_officer_email;
      ({ data: req, error: reqError } = await (supabase
        .from('requests') as any)
        .insert(reqInsertPayload)
        .select()
        .single());
    }

    if (reqError || !req) {
      console.error('[transcript-intake] Request creation error:', reqError);
      return NextResponse.json(
        { error: 'Failed to create request', details: reqError?.message },
        { status: 500 }
      );
    }

    // --- Create entities ---
    // No hard default to '1040' here — infer from tid_kind so EIN entities default
    // to a business form. Explicit form_type in payload still wins (and was already
    // validated for tid-kind compatibility in the block above).
    const entityRows = body.entities.map((ent) => {
      const tidKind = ent.tid_kind?.toUpperCase() === 'SSN' ? 'SSN' : 'EIN';
      const ftInferred = ent.form_type
        ? normalizeFormType(ent.form_type)
        : inferFormTypeFromTidKind(tidKind);
      // Coerce fiscal_year_end_month: null when calendar (12) or out of range.
      const fye = typeof ent.fiscal_year_end_month === 'number'
        && ent.fiscal_year_end_month >= 1
        && ent.fiscal_year_end_month <= 11
          ? ent.fiscal_year_end_month
          : null;
      return {
        request_id: req.id,
        entity_name: ent.entity_name.trim(),
        tid: formatTid(ent.tid.trim(), tidKind),
        tid_kind: tidKind,
        form_type: ftInferred,
        years: ent.years,
        fiscal_year_end_month: fye,
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
      .select('id, entity_name, tid, form_type, years, status');

    if (entError) {
      console.error('[transcript-intake] Entity creation error:', entError);
      return NextResponse.json(
        { error: 'Failed to create entities', details: entError?.message },
        { status: 500 }
      );
    }

    // Debit prepaid credits at order placement (no-op for legacy / non-credit
    // clients or pre-migration). Excludes W&I (W2_INCOME). Mirrors csv/pdf intake.
    if (createdEntities && createdEntities.length) {
      try {
        const { debitCreditsForEntities } = await import('@/lib/credits');
        const billableIds = createdEntities.filter((e: any) => e.form_type !== 'W2_INCOME').map((e: any) => e.id);
        const { charged } = await debitCreditsForEntities(supabase, client.id, billableIds);
        if (charged) console.log(`[transcript-intake] Debited ${charged} request(s) from credit wallet`);
      } catch (e) { console.warn('[transcript-intake] credit debit failed:', e); }
    }

    // --- Auto-fulfill from record (2026-07-02) ---
    // Before this order waits in the IRS queue, check whether ModernTax already
    // has completed transcripts on file for each entity (matched by TIN across
    // all prior pulls — ModernTax is the transcript utility) and, if so, copy
    // them on + deliver immediately. Shared with the self-healing sweep cron so
    // both entry points behave identically. Never fails the intake.
    let servedFromRecord: Array<{ entity_id: string; entity_name: string; prior_loan: string; transcripts: number }> = [];
    let fullyServed = false;
    try {
      const result = await autoFulfillRequestFromRecord(supabase, req.id);
      servedFromRecord = result.served.map((s) => ({
        entity_id: s.entityId, entity_name: s.entityName, prior_loan: s.priorLoan, transcripts: s.transcripts,
      }));
      fullyServed = result.requestCompleted;
    } catch (fulfillErr) {
      console.error('[transcript-intake] auto-fulfill-from-record error (non-fatal):', fulfillErr);
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
    // If every entity was served from record the request is already done;
    // otherwise it's queued (some entities may still have been delivered).
    const fulfilledIds = new Set(servedFromRecord.map((s) => s.entity_id));
    return NextResponse.json({
      success: true,
      request_id: req.id,
      request_token: body.request_token,
      loan_number: loanNumber,
      status: fullyServed ? 'completed' : 'irs_queue',
      entities: (createdEntities || []).map((e: any) => ({
        entity_id: e.id,
        entity_name: e.entity_name,
        form_type: e.form_type,
        years: e.years,
        status: fulfilledIds.has(e.id) ? 'completed' : e.status,
      })),
      // Entities we already had on file and delivered immediately (no IRS pull).
      served_from_record: servedFromRecord,
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

/**
 * GET /api/intake/transcript?token=<request_token>
 *
 * Partner result-polling endpoint. Mirrors the shape of
 * /api/webhook/employment-result?token=. Returns:
 *   - request status + per-entity status
 *   - transcript URLs (signed, 1-hour expiry) for both PDF + HTML
 *   - compliance summary parsed from gross_receipts (severity, flags,
 *     financials, recent transaction codes — first 10 by date)
 *   - signed_8821_url if present
 *
 * Both Moxie and Collective demos asked for this. Today partners get
 * webhook callbacks via lib/webhook (push); this endpoint is the pull
 * counterpart for clients that want to poll on their own cadence.
 *
 * Auth: x-api-key (hashed lookup, constant-time verified).
 *
 * Response shape:
 *   {
 *     request_id, status, request_status, completed_at,
 *     entities: [{
 *       entity_id, entity_name, tid, form_type, years, status,
 *       signed_8821_url,
 *       transcript_urls: string[],            // signed PDF URLs
 *       transcript_html_urls: string[],       // signed HTML URLs
 *       compliance: {
 *         severity: 'CRITICAL' | 'WARNING' | 'CLEAN',
 *         flags: [{ type, severity, message }],
 *         financials: { ... },
 *         recent_transactions: [{ code, explanation, date, amount }],
 *       } | null,
 *       completed_at,
 *     }]
 *   }
 */
export async function GET(request: NextRequest) {
  try {
    const apiKey = request.headers.get('x-api-key');
    if (!apiKey) {
      return NextResponse.json({ error: 'Missing x-api-key header' }, { status: 401 });
    }

    const supabase = createAdminClient();
    const presentedHash = sha256Hex(apiKey);

    const { data: client } = await supabase
      .from('clients')
      .select('id, name, api_key_hash')
      .eq('api_key_hash', presentedHash)
      .single() as { data: { id: string; name: string; api_key_hash: string } | null };

    if (!client || !safeEqual(client.api_key_hash, presentedHash)) {
      return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
    }

    const token = request.nextUrl.searchParams.get('token');
    if (!token) {
      return NextResponse.json(
        { error: 'token query parameter is required' },
        { status: 400 },
      );
    }

    const { data: req } = await supabase
      .from('requests')
      .select('id, status, product_type, external_request_token, created_at, completed_at')
      .eq('external_request_token', token)
      .eq('client_id', client.id)
      .maybeSingle() as { data: any };

    if (!req) {
      return NextResponse.json({ error: 'Request not found' }, { status: 404 });
    }

    // Pull every entity in the request — for transcript orders, multiple
    // entities per request is the common shape (vs. employment which is
    // 1 borrower per request).
    const { data: entities } = await supabase
      .from('request_entities')
      .select('id, entity_name, tid, tid_kind, form_type, years, status, signed_8821_url, transcript_urls, transcript_html_urls, gross_receipts, completed_at, signature_created_at')
      .eq('request_id', req.id)
      .order('created_at', { ascending: true }) as { data: any[] | null };

    // Sign each storage path so the partner can fetch directly. Cap the
    // number of signed-URL operations per response to avoid runaway
    // round-trips on requests with many entities × many transcripts.
    const MAX_URLS_PER_ENTITY = 20;

    const resolveUrls = async (paths: string[] | null): Promise<string[]> => {
      if (!paths || paths.length === 0) return [];
      const out: string[] = [];
      for (const p of paths.slice(0, MAX_URLS_PER_ENTITY)) {
        // Skip if already a full URL (legacy data may store signed URLs).
        if (p.startsWith('http')) {
          out.push(p);
          continue;
        }
        const { data: signed } = await supabase.storage
          .from('uploads')
          .createSignedUrl(p, 3600);
        if (signed?.signedUrl) out.push(signed.signedUrl);
      }
      return out;
    };

    /** Pull the most recent N transactions from gross_receipts. */
    const pickRecentTransactions = (gr: any): any[] => {
      if (!gr) return [];
      // gross_receipts can be { transactionCodes: [...] } from the
      // compliance screener, or per-form keys like { '1120S_RoA_2023':
      // { transactionCodes: [...] } }. Flatten + sort by date desc.
      const all: any[] = [];
      const collect = (txs: any) => {
        if (Array.isArray(txs)) {
          for (const t of txs) {
            if (t && typeof t === 'object' && t.code) all.push(t);
          }
        }
      };
      if (gr.transactionCodes) collect(gr.transactionCodes);
      for (const key of Object.keys(gr)) {
        const v = gr[key];
        if (v && typeof v === 'object' && v.transactionCodes) {
          collect(v.transactionCodes);
        }
      }
      return all
        .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
        .slice(0, 10);
    };

    /** Pick the worst severity across all per-form entries. */
    const aggregateCompliance = (gr: any): any | null => {
      if (!gr) return null;
      const allFlags: any[] = [];
      let financials: any = null;
      const sevRank: Record<string, number> = { CRITICAL: 3, WARNING: 2, CLEAN: 1 };
      let worstSeverity = 'CLEAN';

      const merge = (entry: any) => {
        if (!entry || typeof entry !== 'object') return;
        if (entry.severity && (sevRank[entry.severity] || 0) > (sevRank[worstSeverity] || 0)) {
          worstSeverity = entry.severity;
        }
        if (Array.isArray(entry.flags)) allFlags.push(...entry.flags);
        if (entry.financials && !financials) financials = entry.financials;
      };

      // Top-level (single screener output)
      merge(gr);
      // Per-form keys (e.g. '1120S_RoA_2023')
      for (const key of Object.keys(gr)) {
        const v = gr[key];
        if (v && typeof v === 'object' && (v.severity || v.flags || v.financials)) {
          merge(v);
        }
      }

      if (!worstSeverity && !allFlags.length && !financials) return null;
      return {
        severity: worstSeverity,
        flags: allFlags,
        financials,
        recent_transactions: pickRecentTransactions(gr),
      };
    };

    const entitiesOut = await Promise.all(
      (entities || []).map(async (e: any) => ({
        entity_id: e.id,
        entity_name: e.entity_name,
        tid: e.tid,
        tid_kind: e.tid_kind,
        form_type: e.form_type,
        years: e.years,
        status: e.status,
        signed_8821_url: e.signed_8821_url
          ? (await supabase.storage.from('uploads').createSignedUrl(e.signed_8821_url, 3600)).data?.signedUrl || null
          : null,
        signature_created_at: e.signature_created_at,
        transcript_urls: await resolveUrls(e.transcript_urls),
        transcript_html_urls: await resolveUrls(e.transcript_html_urls),
        compliance: aggregateCompliance(e.gross_receipts),
        completed_at: e.completed_at,
      })),
    );

    // Audit log — we want a record of every partner result-pull so we
    // can spot abuse (e.g. someone scraping all completed requests).
    await logAuditFromRequest(supabase, request, {
      action: 'transcript_result_retrieved',
      resourceType: 'request',
      resourceId: req.id,
      details: {
        client_name: client.name,
        request_token: token,
        entity_count: entitiesOut.length,
      },
    });

    return NextResponse.json({
      request_id: token,
      status: req.status === 'completed' ? 'completed' : 'pending',
      request_status: req.status,
      created_at: req.created_at,
      completed_at: req.completed_at,
      entities: entitiesOut,
    });
  } catch (err) {
    console.error('[transcript-intake GET] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
