import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import { send8821WithFallback } from '@/lib/send-8821-with-fallback';
import { autoPostIntakeNote } from '@/lib/intake-note-autopost';
import { sendAdminNewRequestNotification, sendManagerEntityTranscriptNotification } from '@/lib/sendgrid';
import { RATE_ENTITY_TRANSCRIPT } from '@/lib/clients';
import { findPriorEntities, attachPriorTranscripts, autoEnrollMonitoring, type RepeatEntityMatch } from '@/lib/repeat-entity';
import {
  inferFormTypeFromTidKind,
  normalizeFormType,
  validateFormTypeMatchesTidKind,
} from '@/lib/form-type-validation';
import * as XLSX from 'xlsx';

interface CsvRow {
  legal_name: string;
  tid: string;
  tid_kind: string;
  address: string;
  city: string;
  state: string;
  zip_code: string;
  signature_id: string;
  'first name': string;
  'last name': string;
  email: string;
  signature_created_at: string;
  credit_application_id: string;
  years: string;
  form: string;
  fye_month: string; // raw value — could be "2", "Feb", "2/28", "February"
}

// Normalize column headers to handle case/spacing variations
function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, '_');
}

function mapRow(raw: Record<string, unknown>): CsvRow {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    normalized[normalizeHeader(key)] = String(value ?? '').trim();
  }

  return {
    legal_name: normalized['legal_name'] || normalized['legalname'] || '',
    tid: normalized['tid'] || '',
    tid_kind: normalized['tid_kind'] || normalized['tidkind'] || 'EIN',
    address: normalized['address'] || '',
    city: normalized['city'] || '',
    state: normalized['state'] || '',
    zip_code: normalized['zip_code'] || normalized['zipcode'] || normalized['zip'] || '',
    signature_id: normalized['signature_id'] || normalized['signatureid'] || '',
    // Accept the column-name variants real lender exports use. Cal Statewide
    // and Centerstone both ship with combinations of {signer_, owner_, officer_}
    // prefixes — supporting all three lets the processor upload the raw export
    // without renaming columns. Order matters: most specific wins.
    'first name':
      normalized['first_name'] || normalized['firstname'] ||
      normalized['signer_first_name'] || normalized['signerfirstname'] ||
      normalized['owner_first_name'] || normalized['ownerfirstname'] ||
      normalized['officer_first_name'] || normalized['officerfirstname'] || '',
    'last name':
      normalized['last_name'] || normalized['lastname'] ||
      normalized['signer_last_name'] || normalized['signerlastname'] ||
      normalized['owner_last_name'] || normalized['ownerlastname'] ||
      normalized['officer_last_name'] || normalized['officerlastname'] || '',
    email: normalized['email'] || normalized['signer_email'] || normalized['signeremail'] || findEmailValue(normalized) || '',
    signature_created_at: normalized['signature_created_at'] || normalized['signaturecreatedat'] || '',
    credit_application_id:
      normalized['credit_application_id'] ||
      normalized['creditapplicationid'] ||
      normalized['loan_number'] ||
      normalized['loannumber'] ||
      normalized['loan_#'] ||
      normalized['loan#'] ||
      '',
    years: normalized['years'] || normalized['year'] || '',
    // No hard '1040' default — let form-type resolution run against tid_kind later.
    // Empty string falls through `normalizeFormType()` returning null, and the
    // entity-build code infers from tid_kind instead of blindly stamping 1040.
    form: normalized['form'] || normalized['form_type'] || normalized['formtype'] || '',
    // Fiscal year end — column may be "fye", "fye_month", "fiscal_year_end",
    // "fiscal_year_end_month", or "fiscal_year_end_date" (the last surfaces
    // from lender exports as "2/28" or "02-28"). All variants accepted;
    // parseFyeMonth() normalizes to 1-12.
    fye_month:
      normalized['fye_month'] || normalized['fyemonth'] ||
      normalized['fiscal_year_end_month'] || normalized['fiscalyearendmonth'] ||
      normalized['fye'] || normalized['fiscal_year_end'] || normalized['fiscalyearend'] ||
      normalized['fiscal_year_end_date'] || normalized['fiscalyearenddate'] || '',
  };
}

/**
 * Parse a fiscal-year-end value (could be "2", "Feb", "February", "2/28",
 * "02-28") into a 1-12 month number. Returns null when the value indicates
 * calendar year (empty, "12", "Dec", "12/31") or is unparseable.
 *
 * Driver: Katie Lent at Growth Corp got burned by a vendor pulling 12/31
 * transcripts for a 2/28 fiscal-year entity. This is the normalizer that
 * makes sure the field gets captured regardless of how the lender CSV
 * formats it.
 */
function parseFyeMonth(raw: string): number | null {
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase();
  if (!cleaned) return null;
  // "12", "12/31", "December", "Dec" → calendar year, store as null.
  if (/^(12|december|dec|12\/31|12-31)$/.test(cleaned)) return null;
  // Pure integer 1-11
  const intMatch = cleaned.match(/^(\d{1,2})$/);
  if (intMatch) {
    const m = parseInt(intMatch[1], 10);
    return m >= 1 && m <= 11 ? m : null;
  }
  // "M/DD" or "MM/DD" or "MM-DD" — take the month component
  const dateMatch = cleaned.match(/^(\d{1,2})[/-]\d{1,2}$/);
  if (dateMatch) {
    const m = parseInt(dateMatch[1], 10);
    return m >= 1 && m <= 11 ? m : null;
  }
  // Month name (full or abbreviated)
  const months: Record<string, number> = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
    apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
    aug: 8, august: 8, sep: 9, sept: 9, september: 9,
    oct: 10, october: 10, nov: 11, november: 11,
  };
  return months[cleaned] ?? null;
}

// Find email in unlabeled columns (e.g., __EMPTY, __EMPTY_1)
function findEmailValue(normalized: Record<string, string>): string {
  for (const [key, value] of Object.entries(normalized)) {
    if (key.startsWith('__empty') && value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      return value;
    }
  }
  return '';
}

// NOTE: the local validateFormType() helper used to live here. It only validated
// the form code shape and ignored tid_kind compatibility — that's the bug that
// produced 116 mis-routed 8821s. Replaced with normalizeFormType +
// validateFormTypeMatchesTidKind from lib/form-type-validation, which both
// parses the form AND auto-corrects when it conflicts with tid_kind.

function parseYears(years: string): string[] {
  if (!years) return [];
  // Strip Postgres array braces {2022,2023} and quotes
  const cleaned = years.replace(/[{}'"]/g, '');
  // Handle comma-separated, space-separated, or single year
  return cleaned
    .split(/[,;\s]+/)
    .map((y) => y.trim())
    .filter((y) => /^\d{4}$/.test(y));
}

function parseSignatureDate(raw: string): string | null {
  if (!raw) return null;
  // Handle Excel serial date numbers (e.g., 46063 = 2/10/2026)
  const num = Number(raw);
  if (!isNaN(num) && num > 40000 && num < 60000) {
    const excelEpoch = new Date(1899, 11, 30);
    const date = new Date(excelEpoch.getTime() + num * 86400000);
    return date.toISOString();
  }
  const parsed = new Date(raw);
  if (!isNaN(parsed.getTime())) return parsed.toISOString();
  return null;
}

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);

    // Check auth
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get profile
    const { data: profile } = (await supabase
      .from('profiles')
      .select('client_id, full_name, role')
      .eq('id', user.id)
      .single()) as { data: { client_id: string | null; full_name: string | null; role: string } | null; error: unknown };

    if (!profile?.client_id) {
      return NextResponse.json({ error: 'No client associated' }, { status: 400 });
    }

    // Get client name for notifications
    const { data: clientRecord } = await supabase
      .from('clients')
      .select('name')
      .eq('id', profile.client_id)
      .single() as { data: { name: string } | null; error: any };
    const clientName = clientRecord?.name || 'Unknown';

    // Order gate — block CSV intake if the client has used up their 3 free
    // trial pulls AND has no payment method on file. Returns 402 Payment
    // Required with a CTA to /payment-method so the dashboard can prompt.
    const { checkOrderGate, buildOrderGateErrorBody } = await import('@/lib/order-gate');
    const adminForGate = createAdminClient();
    const gate = await checkOrderGate(adminForGate, profile.client_id);
    if (!gate.allowed) {
      return NextResponse.json(buildOrderGateErrorBody(gate), { status: gate.status || 402 });
    }

    // Parse multipart form data
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const loanNumber = formData.get('loan_number') as string | null;
    const notes = formData.get('notes') as string | null;
    const entityTranscriptIndicesRaw = formData.get('entity_transcript_indices') as string | null;
    const cashFlowPackIndicesRaw = formData.get('cash_flow_pack_indices') as string | null;
    const skipMonitoringIndicesRaw = formData.get('skip_monitoring_indices') as string | null;
    const formTypeOverridesRaw = formData.get('form_type_overrides') as string | null;

    // Parse the three add-on selection arrays. Each is a JSON array of row
    // indices (0-based, matching the CSV preview). Server stores per-entity
    // flags so the post-completion hooks (cash-flow generator, monitoring
    // auto-enroll) know what each entity opted into.
    const safeParseIndices = (raw: string | null, label: string): number[] => {
      if (!raw) return [];
      try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr.filter((n): n is number => typeof n === 'number') : [];
      } catch {
        console.warn(`[csv-upload] Failed to parse ${label}`);
        return [];
      }
    };
    const entityTranscriptIndices = safeParseIndices(entityTranscriptIndicesRaw, 'entity_transcript_indices');
    const cashFlowPackIndices = safeParseIndices(cashFlowPackIndicesRaw, 'cash_flow_pack_indices');
    const skipMonitoringIndices = safeParseIndices(skipMonitoringIndicesRaw, 'skip_monitoring_indices');

    // Per-row form_type overrides — the client UI lets processors override
    // the CSV-derived form_type via the preview dropdown (the only path
    // to flag a row as 941 when the source CSV doesn't include 941 in
    // its form column). Indexed by rowIndex.
    const formTypeOverridesByRow = new Map<number, string>();
    if (formTypeOverridesRaw) {
      try {
        const arr = JSON.parse(formTypeOverridesRaw);
        if (Array.isArray(arr)) {
          for (const o of arr) {
            if (o && typeof o.rowIndex === 'number' && typeof o.formType === 'string') {
              formTypeOverridesByRow.set(o.rowIndex, o.formType);
            }
          }
        }
      } catch {
        console.warn('[csv-upload] Failed to parse form_type_overrides');
      }
    }

    // Server-side notes guard — mirror the client-side requirement so
    // a determined caller can't bypass the UI by direct POST. Non-
    // standard form types (941, W2_INCOME, 990, 1041) need notes
    // explaining intent.
    const NON_STANDARD_FORM_TYPES = new Set(['941', '990', '1041', 'W2_INCOME']);
    const hasNonStandard = Array.from(formTypeOverridesByRow.values()).some(ft => NON_STANDARD_FORM_TYPES.has(ft));
    if (hasNonStandard && (!notes || notes.trim().length < 10)) {
      return NextResponse.json(
        {
          error: 'Notes required for 941/W2/990/1041 requests',
          details: 'Please describe specific quarters/years and what the expert should confirm (e.g. ERC refund status, claim pending, denied).',
        },
        { status: 400 },
      );
    }

    if (!file) {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    }

    if (!loanNumber?.trim()) {
      return NextResponse.json({ error: 'Loan number is required' }, { status: 400 });
    }

    // Read file as buffer
    const buffer = Buffer.from(await file.arrayBuffer());

    // Parse with SheetJS
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);

    if (rawRows.length === 0) {
      return NextResponse.json({ error: 'File contains no data rows' }, { status: 400 });
    }

    // Map rows from raw spreadsheet
    const rows = rawRows.map(mapRow);

    // -----------------------------------------------------------------
    // Year-extension carve-out: when a TID already exists with a signed
    // 8821 on file, the row is treated as a "request more years for an
    // existing borrower" — we don't need to re-collect first name / last
    // name / email / address because they're already on the prior entity.
    //
    // This unblocks the common Tim/processor flow where they upload a slim
    // file (just legal_name + tid + tid_kind + address + years + form) for
    // borrowers we've already worked. Without this carve-out the upload
    // bounces with "missing first name / email / etc." even though we
    // already have everything needed.
    //
    // We also auto-derive first/last from `Legal Name` when those columns
    // aren't present, so a fresh single-name "Lillian Aguirre" entry can
    // still build a valid 8821 if needed.
    // -----------------------------------------------------------------
    const adminForLookup = createAdminClient();
    const candidateTids = rows.map(r => (r.tid || '').replace(/\D/g, '')).filter(Boolean);
    const existingByTid = new Map<string, { signer_first_name: string | null; signer_last_name: string | null; signer_email: string | null; address: string | null; city: string | null; state: string | null; zip_code: string | null; signed_8821_url: string | null }>();
    if (candidateTids.length > 0) {
      const { data: priorEntities } = await adminForLookup
        .from('request_entities')
        .select('tid, signer_first_name, signer_last_name, signer_email, address, city, state, zip_code, signed_8821_url, status')
        .in('tid', candidateTids)
        .not('signed_8821_url', 'is', null) as { data: any[] | null };
      for (const e of (priorEntities || [])) {
        const tidNorm = (e.tid || '').replace(/\D/g, '');
        if (!tidNorm) continue;
        // Keep the most-completely-populated record we find for this TID
        const existing = existingByTid.get(tidNorm);
        if (!existing || (!existing.signer_email && e.signer_email)) {
          existingByTid.set(tidNorm, {
            signer_first_name: e.signer_first_name,
            signer_last_name: e.signer_last_name,
            signer_email: e.signer_email,
            address: e.address,
            city: e.city,
            state: e.state,
            zip_code: e.zip_code,
            signed_8821_url: e.signed_8821_url,
          });
        }
      }
    }

    // Backfill missing fields per-row from prior matches + Legal Name parsing
    rows.forEach((row) => {
      const tidNorm = (row.tid || '').replace(/\D/g, '');
      const prior = existingByTid.get(tidNorm);
      // Auto-derive first/last from "Legal Name" — INDIVIDUALS ONLY.
      //
      // For SSN/ITIN entities, legal_name IS the person's name ("Rafael
      // Castaneda Alamillo") and splitting on whitespace gives a usable
      // first/last. For business entities (EIN), legal_name is the company
      // name ("RJ Custom Trailers LLC") — splitting that would silently
      // stamp first="RJ", last="Custom Trailers LLC", which is wrong: the
      // signer is the OFFICER, not the entity. Business rows must carry
      // explicit signer_first_name / signer_last_name (or officer_/owner_
      // variants — see column aliases above).
      const isIndividual = ['SSN', 'ITIN'].includes((row.tid_kind || '').toUpperCase());
      if (isIndividual && (!row['first name'] || !row['last name']) && row.legal_name) {
        const parts = row.legal_name.trim().split(/\s+/);
        if (parts.length >= 2) {
          if (!row['first name']) row['first name'] = parts[0];
          if (!row['last name'])  row['last name']  = parts.slice(1).join(' ');
        }
      }
      // Year-extension: pull anything still missing from the prior entity
      if (prior) {
        if (!row['first name'] && prior.signer_first_name) row['first name'] = prior.signer_first_name;
        if (!row['last name']  && prior.signer_last_name)  row['last name']  = prior.signer_last_name;
        if (!row.email         && prior.signer_email)      row.email         = prior.signer_email;
        if (!row.address       && prior.address)           row.address       = prior.address;
        if (!row.city          && prior.city)              row.city          = prior.city;
        if (!row.state         && prior.state)             row.state         = prior.state;
        if (!row.zip_code      && prior.zip_code)          row.zip_code      = prior.zip_code;
      }
    });

    // Validate after backfill — anything still missing is genuinely
    // ungenerable. Year-extension rows with prior 8821 + email get a pass
    // on email since the 8821 is already on file.
    const errors: string[] = [];
    rows.forEach((row, idx) => {
      const rowNum = idx + 2;
      const tidNorm = (row.tid || '').replace(/\D/g, '');
      const isYearExtension = !!existingByTid.get(tidNorm);
      const isIndividual = ['SSN', 'ITIN'].includes((row.tid_kind || '').toUpperCase());
      if (!row.legal_name) errors.push(`Row ${rowNum}: missing legal_name`);
      if (!row.tid) errors.push(`Row ${rowNum}: missing tid`);
      // For year-extension rows we don't strictly need email — the existing
      // 8821 carries forward. For new borrowers, email is required.
      if (!isYearExtension && !row.email) errors.push(`Row ${rowNum}: missing email (required for 8821 delivery — TID ${row.tid} not previously verified)`);
      // Different error messages for individual vs business — for individuals
      // we attempt legal_name parsing first, so "missing" usually means the
      // name was a single word. For businesses, legal_name was the entity name
      // (we deliberately did NOT parse it) so the processor needs to add an
      // explicit officer/owner column.
      if (!row['first name']) {
        errors.push(
          isIndividual
            ? `Row ${rowNum}: missing first name (legal_name "${row.legal_name}" must contain at least two words for individuals, OR add a signer_first_name column)`
            : `Row ${rowNum}: missing first name — business entities (EIN) need an officer/owner name. Add a signer_first_name (or owner_first_name / officer_first_name) column to your CSV.`,
        );
      }
      if (!row['last name']) {
        errors.push(
          isIndividual
            ? `Row ${rowNum}: missing last name (legal_name must contain at least two words, OR add a signer_last_name column)`
            : `Row ${rowNum}: missing last name — business entities (EIN) need an officer/owner name. Add a signer_last_name (or owner_last_name / officer_last_name) column to your CSV.`,
        );
      }
      if (!row.address) errors.push(`Row ${rowNum}: missing address`);
      if (!row.city) errors.push(`Row ${rowNum}: missing city`);
      if (!row.state) errors.push(`Row ${rowNum}: missing state`);
      if (!row.zip_code) errors.push(`Row ${rowNum}: missing zip_code`);
    });

    if (errors.length > 0) {
      return NextResponse.json(
        {
          error: 'Validation errors — fix the listed rows or include the missing columns. Borrowers with TIDs we have on file from prior loans can skip first/last/email/address — the system reuses prior 8821 data automatically.',
          details: errors.slice(0, 20),
        },
        { status: 400 }
      );
    }

    // Upload source file to storage
    const admin = createAdminClient();
    const filePath = `${profile.client_id}/${Date.now()}-${file.name}`;
    const { error: uploadError } = await admin.storage
      .from('uploads')
      .upload(filePath, buffer, {
        contentType: file.type,
        upsert: false,
      });

    const sourceFileUrl = uploadError ? null : filePath;

    // Mercury enrollment is now enforced inside checkOrderGate (called
    // earlier at line 214). Unified gate replaces the parallel paywall.

    // Use the loan number from the form — all entities go under one request
    const effectiveLoanNumber = loanNumber!.trim();

    // Create batch
    const { data: batch, error: batchError } = (await supabase
      .from('batches')
      .insert({
        client_id: profile.client_id,
        uploaded_by: user.id,
        intake_method: 'csv',
        source_file_url: sourceFileUrl,
        original_filename: file.name,
        entity_count: rows.length,
        request_count: 1,
        status: 'completed',
      })
      .select()
      .single()) as { data: { id: string } | null; error: unknown };

    if (batchError || !batch) {
      console.error('Batch creation error:', batchError);
      return NextResponse.json({ error: 'Failed to create batch' }, { status: 500 });
    }

    // Create single request with the user-provided loan number
    const { data: req, error: reqError } = (await supabase
      .from('requests')
      .insert({
        client_id: profile.client_id,
        requested_by: user.id,
        batch_id: batch.id,
        loan_number: effectiveLoanNumber,
        intake_method: 'csv',
        status: 'submitted',
        notes: notes || null,
      })
      .select()
      .single()) as { data: { id: string } | null; error: unknown };

    if (reqError || !req) {
      console.error('Request creation error:', reqError);
      return NextResponse.json({ error: 'Failed to create request' }, { status: 500 });
    }

    // Track form-type auto-corrections so the response payload can show the
    // processor exactly what we changed and why. This is the "kill 1040-on-EIN"
    // bug fix: the old logic silently accepted explicit form_type=1040 even
    // when tid_kind=EIN, producing 116 rows of misrouted 8821s in production.
    const formTypeCorrections: Array<{
      row: number;
      entity_name: string;
      tid_kind: string;
      original_form: string;
      corrected_form: string;
      reason: string;
    }> = [];

    // Create entities from CSV rows
    const entities = rows.map((row, idx) => {
      const resolvedTidKind: 'SSN' | 'EIN' =
        ['SSN', 'ITIN'].includes(row.tid_kind?.toUpperCase()) ? 'SSN' : 'EIN';

      // Form-type resolution flow:
      //   1. If explicit form is provided, normalize it via the central lib
      //      (handles "1120-S" / "S corp" / "FORM1040" aliases).
      //   2. Check it against tid_kind. If it MISMATCHES (EIN entity tagged
      //      1040, or vice versa), AUTO-CORRECT to the inferred form and
      //      record the correction in the response. We trust tid_kind as
      //      source of truth — TID format is the authoritative signal.
      //   3. If no explicit form was provided, infer from tid_kind silently.
      let resolvedForm = inferFormTypeFromTidKind(resolvedTidKind);
      const normalizedExplicit = normalizeFormType(row.form);
      if (normalizedExplicit) {
        const mismatch = validateFormTypeMatchesTidKind(resolvedTidKind, normalizedExplicit);
        if (mismatch) {
          // Auto-correct + log. The processor sees a warning in the response
          // and can fix their CSV mapping going forward.
          formTypeCorrections.push({
            row: idx + 2,
            entity_name: row.legal_name,
            tid_kind: resolvedTidKind,
            original_form: row.form,
            corrected_form: resolvedForm,
            reason: mismatch,
          });
        } else {
          resolvedForm = normalizedExplicit;
        }
      }

      // Per-row UI override (from the preview-table dropdown) trumps the
      // CSV-derived value. Validate it against tid_kind for safety; if
      // the user picked an obviously-incompatible form (e.g. 1040 on an
      // EIN row), fall back to the CSV-resolved one and log a correction.
      const uiOverride = formTypeOverridesByRow.get(idx);
      if (uiOverride) {
        const normalizedUi = normalizeFormType(uiOverride);
        if (normalizedUi) {
          const mismatch = validateFormTypeMatchesTidKind(resolvedTidKind, normalizedUi);
          if (mismatch) {
            formTypeCorrections.push({
              row: idx + 2,
              entity_name: row.legal_name,
              tid_kind: resolvedTidKind,
              original_form: uiOverride,
              corrected_form: resolvedForm,
              reason: `UI override rejected — ${mismatch}`,
            });
          } else {
            resolvedForm = normalizedUi;
          }
        }
      }

      const entityData: Record<string, any> = {
        request_id: req.id,
        entity_name: row.legal_name,
        tid: row.tid,
        tid_kind: resolvedTidKind,
        address: row.address || null,
        city: row.city || null,
        state: row.state || null,
        zip_code: row.zip_code || null,
        form_type: resolvedForm,
        years: parseYears(row.years),
        // Non-calendar fiscal year end (1-11). NULL = calendar year (Dec).
        // Accepts CSV columns: fye, fye_month, fiscal_year_end, etc.
        // Driver: Growth Corp / Katie Lent vendor-swap case.
        fiscal_year_end_month: parseFyeMonth(row.fye_month),
        signer_first_name: row['first name'] || null,
        signer_last_name: row['last name'] || null,
        signer_email: row.email || null,
        signature_id: row.signature_id || null,
        signature_created_at: parseSignatureDate(row.signature_created_at),
        status: row.signature_id ? '8821_signed' : 'pending',
      };

      // Stamp per-entity add-on flags into gross_receipts. Each is read by a
      // post-completion hook (cash-flow generator runs after transcripts upload,
      // monitoring auto-enroll runs as the entity flips to status='completed').
      const grossReceipts: Record<string, unknown> = {};
      if (entityTranscriptIndices.includes(idx)) {
        grossReceipts.entity_transcript_order = {
          requested: true,
          price: RATE_ENTITY_TRANSCRIPT,
          ordered_at: new Date().toISOString(),
        };
      }
      if (cashFlowPackIndices.includes(idx)) {
        // Pre-order: marker for the upload-transcript completion hook to
        // generate the cash-flow PDF as soon as transcripts are uploaded.
        grossReceipts.cash_flow_pack_pre_ordered = {
          requested: true,
          price: 49.99,
          ordered_at: new Date().toISOString(),
        };
      }
      if (skipMonitoringIndices.includes(idx)) {
        // Per-entity monitoring opt-out — overrides the client-level default-on.
        // Read by the auto-enroll hook in app/api/expert/upload-transcript.
        grossReceipts.skip_auto_monitoring = {
          requested: true,
          opted_out_at: new Date().toISOString(),
        };
      }
      if (Object.keys(grossReceipts).length > 0) {
        entityData.gross_receipts = grossReceipts;
      }

      return entityData;
    });

    const { error: entError } = await supabase.from('request_entities').insert(entities as any);
    const entityCount = entError ? 0 : entities.length;

    if (entError) {
      console.error('Entity creation error:', entError);
    }

    // --- Repeat Entity Intelligence ---
    // Check if any entities have been previously verified (same TID in completed requests)
    const repeatEntities: RepeatEntityMatch[] = [];

    if (!entError) {
      try {
        const { data: createdEntities } = await admin
          .from('request_entities')
          .select('id, entity_name, tid, tid_kind, form_type, status, signature_id')
          .eq('request_id', req.id) as { data: any[] | null; error: any };

        if (createdEntities) {
          for (const entity of createdEntities) {
            if (!entity.tid || entity.signature_id) continue;

            const priorMatches = await findPriorEntities(admin, entity.tid, entity.id);
            if (priorMatches.length > 0) {
              const best = priorMatches[0]; // Most recent completed match

              // Auto-attach prior transcripts + compliance data
              const attached = await attachPriorTranscripts(admin, entity.id, best);
              if (attached) {
                console.log(`[csv-upload] Repeat entity: ${entity.entity_name} (TID ${entity.tid}) — attached ${best.transcriptCount} prior transcripts from loan ${best.loanNumber}`);
              }

              // Auto-enroll in monitoring (quarterly)
              const enrolled = await autoEnrollMonitoring(admin, entity.id, req.id, profile.client_id!, user.id);
              if (enrolled) {
                console.log(`[csv-upload] Auto-enrolled ${entity.entity_name} in quarterly monitoring`);
              }

              repeatEntities.push({
                entityId: entity.id,
                entityName: entity.entity_name,
                priorLoan: best.loanNumber,
                priorCompletedAt: best.completedAt,
                transcriptsAttached: best.transcriptCount,
                complianceSummary: best.complianceSummary,
                monitoringEnrolled: enrolled,
                eightyTwentyOneSkipped: attached,
              });
            }
          }
        }
      } catch (repeatErr) {
        console.error('[csv-upload] Repeat entity check error:', repeatErr);
      }
    }

    // Auto-send 8821 via Dropbox Sign for entities with signer email (and no existing signature)
    // Skip entities that were auto-completed via repeat entity intelligence
    if (!entError) {
      try {
        const { data: createdEntities } = await admin
          .from('request_entities')
          .select('id, entity_name, form_type, tid, tid_kind, signer_first_name, signer_last_name, signer_email, address, city, state, zip_code, signature_id, status')
          .eq('request_id', req.id) as { data: any[] | null; error: any };

        if (createdEntities) {
          for (const entity of createdEntities) {
            // Skip if already has a signature_id (pre-signed from CSV)
            if (entity.signature_id) continue;
            // Skip if already completed (repeat entity auto-attached transcripts)
            if (entity.status === 'completed') continue;
            // Skip employment entities
            if (entity.form_type === 'W2_INCOME') continue;
            // Must have signer email
            if (!entity.signer_email) continue;

            // Uses the shared helper that falls back to a manual-PDF
            // email if Dropbox Sign returns 402 (free-tier blocked). The
            // helper updates the row's status + signature_id itself.
            const result = await send8821WithFallback(entity, admin);
            if (result.outcome === 'sent_hellosign') {
              console.log(`[csv-upload] 8821 sent via HelloSign for ${entity.entity_name} (entity ${entity.id?.slice(0, 8) || '?'})`);
            } else if (result.outcome === 'sent_manual') {
              console.log(`[csv-upload] 8821 sent via MANUAL email for ${entity.entity_name} (entity ${entity.id?.slice(0, 8) || '?'})`);
            } else {
              console.error(`[csv-upload] Failed to send 8821 for ${entity.entity_name}: ${result.error}`);
            }
          }

          // Update request status if all entities have been sent or completed
          const { data: updatedEntities } = await admin
            .from('request_entities')
            .select('status')
            .eq('request_id', req.id) as { data: any[] | null; error: any };

          if (updatedEntities) {
            const allDone = updatedEntities.every(
              (e: any) => ['8821_sent', '8821_signed', 'irs_queue', 'processing', 'completed'].includes(e.status)
            );
            if (allDone) {
              await admin.from('requests').update({ status: '8821_sent' }).eq('id', req.id);
            }
          }
        }
      } catch (signError) {
        console.error('[csv-upload] 8821 auto-send error:', signError);
      }
    }

    // Auto-post the intake instruction note on each created entity so
    // the expert sees what was requested directly — no admin relay.
    // Fire-and-forget per entity; failures logged but don't fail the
    // intake. Driver: 2026-05-27 Matt "no admin back-and-forth" directive.
    try {
      const { data: allCreated } = await admin
        .from('request_entities')
        .select('id, entity_name, form_type, years')
        .eq('request_id', req.id) as { data: any[] | null };
      if (allCreated && allCreated.length > 0) {
        const intakeRequesterName = profile.full_name || user.email || 'Processor';
        await Promise.allSettled(allCreated.map((e: any) =>
          autoPostIntakeNote(admin, {
            entityId: e.id,
            entityName: e.entity_name,
            formType: e.form_type,
            years: e.years,
            requesterUserId: user.id,
            requesterName: intakeRequesterName,
            requesterRole: (profile.role === 'admin' || profile.role === 'expert' || profile.role === 'processor' || profile.role === 'manager')
              ? profile.role : 'processor',
            clientId: profile.client_id!,
            freeTextNotes: notes,
          }),
        ));
      }
    } catch (noteErr) {
      console.warn('[csv-upload] intake-note autopost failed (non-fatal):', noteErr);
    }

    // Notify all admins about the new request in real-time
    try {
      const { data: admins } = await admin
        .from('profiles')
        .select('email')
        .eq('role', 'admin');

      if (admins && admins.length > 0) {
        for (const admin of admins) {
          await sendAdminNewRequestNotification(
            admin.email,
            profile.full_name || user.email || 'Team Member',
            profile.role || 'processor',
            clientName,
            effectiveLoanNumber,
            entityCount,
            req.id
          );
        }
      }
    } catch (notifyErr) {
      console.error('[csv-upload] Failed to send admin notification:', notifyErr);
    }

    // Notify manager(s) if processor ordered entity transcripts
    if (entityTranscriptIndices.length > 0) {
      try {
        const { data: managers } = await admin
          .from('profiles')
          .select('email')
          .eq('client_id', profile.client_id)
          .eq('role', 'manager');

        if (managers && managers.length > 0) {
          const totalCost = entityTranscriptIndices.length * RATE_ENTITY_TRANSCRIPT;
          for (const manager of managers) {
            await sendManagerEntityTranscriptNotification(
              manager.email,
              profile.full_name || user.email || 'Team Member',
              clientName,
              effectiveLoanNumber,
              entityTranscriptIndices.length,
              totalCost,
              req.id
            );
          }
          console.log(`[csv-upload] Notified ${managers.length} manager(s) about entity transcript add-on`);
        }
      } catch (managerNotifyErr) {
        console.error('[csv-upload] Failed to send manager entity transcript notification:', managerNotifyErr);
      }
    }

    // Audit log: CSV upload completed
    await logAuditFromRequest(supabase, request, {
      action: 'file_uploaded',
      resourceType: 'batch',
      resourceId: batch.id,
      details: {
        intake_method: 'csv',
        filename: file.name,
        entity_count: entityCount,
        request_id: req.id,
        loan_number: effectiveLoanNumber,
      },
    });

    // Surface auto-corrections so the upload UI can show a clear warning
    // banner: "We changed form_type 1040 → 1120 for 3 rows because tid_kind=EIN".
    // The processor doesn't have to act on it, but they get visibility into
    // the bug class that historically produced 116 mis-routed 8821s.
    return NextResponse.json({
      success: true,
      batch_id: batch.id,
      request_id: req.id,
      requests_created: 1,
      entities_created: entityCount,
      loan_numbers: [effectiveLoanNumber],
      repeat_entities: repeatEntities.length > 0 ? repeatEntities : undefined,
      form_type_corrections: formTypeCorrections.length > 0 ? formTypeCorrections : undefined,
      // Add-on counts so the UI success screen can recap "X add-ons selected".
      entity_transcripts_ordered: entityTranscriptIndices.length || undefined,
      cash_flow_packs_ordered: cashFlowPackIndices.length || undefined,
      monitoring_enrollments_skipped: skipMonitoringIndices.length || undefined,
    });
  } catch (err) {
    console.error('CSV upload error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Upload failed' },
      { status: 500 }
    );
  }
}
