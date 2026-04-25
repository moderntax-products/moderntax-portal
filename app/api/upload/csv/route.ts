import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import { sendSignatureRequest } from '@/lib/dropbox-sign';
import { sendAdminNewRequestNotification, sendManagerEntityTranscriptNotification } from '@/lib/sendgrid';
import { RATE_ENTITY_TRANSCRIPT } from '@/lib/clients';
import { findPriorEntities, attachPriorTranscripts, autoEnrollMonitoring, type RepeatEntityMatch } from '@/lib/repeat-entity';
import { inferFormTypeFromTidKind } from '@/lib/form-type-validation';
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
    'first name': normalized['first_name'] || normalized['firstname'] || '',
    'last name': normalized['last_name'] || normalized['lastname'] || '',
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
    // Passing '' here means `validateFormType` falls through and the entity-build
    // code infers from tid_kind instead of blindly stamping 1040.
    form: normalized['form'] || normalized['form_type'] || normalized['formtype'] || '',
  };
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

/**
 * Parse the CSV's "form" column. Returns null if unparseable, letting the
 * caller infer from tid_kind instead of blindly returning '1040'.
 */
function validateFormType(form: string): string | null {
  if (!form || !form.trim()) return null;
  // Take only the part before the first comma (e.g., "1120-S, tax transcripts" → "1120-S")
  const formPart = form.split(',')[0].trim();
  const normalized = formPart.replace(/[\s-]/g, '').toUpperCase();
  const valid = ['1040', '1065', '1120', '1120S'];
  if (valid.includes(normalized)) return normalized;
  const stripped = normalized.replace('FORM', '');
  if (valid.includes(stripped)) return stripped;
  return null;
}

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

    // Parse multipart form data
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const loanNumber = formData.get('loan_number') as string | null;
    const notes = formData.get('notes') as string | null;
    const entityTranscriptIndicesRaw = formData.get('entity_transcript_indices') as string | null;

    // Parse entity transcript indices (row indices from the preview that the processor selected)
    let entityTranscriptIndices: number[] = [];
    if (entityTranscriptIndicesRaw) {
      try {
        entityTranscriptIndices = JSON.parse(entityTranscriptIndicesRaw);
      } catch {
        console.warn('[csv-upload] Failed to parse entity_transcript_indices');
      }
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
      // Auto-derive first/last from "Legal Name" when split fields are missing
      if ((!row['first name'] || !row['last name']) && row.legal_name) {
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
      if (!row.legal_name) errors.push(`Row ${rowNum}: missing legal_name`);
      if (!row.tid) errors.push(`Row ${rowNum}: missing tid`);
      // For year-extension rows we don't strictly need email — the existing
      // 8821 carries forward. For new borrowers, email is required.
      if (!isYearExtension && !row.email) errors.push(`Row ${rowNum}: missing email (required for 8821 delivery — TID ${row.tid} not previously verified)`);
      if (!row['first name']) errors.push(`Row ${rowNum}: missing first name (legal_name must contain at least two words)`);
      if (!row['last name'])  errors.push(`Row ${rowNum}: missing last name (legal_name must contain at least two words)`);
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

    // Create entities from CSV rows
    const entities = rows.map((row, idx) => {
      const resolvedTidKind: 'SSN' | 'EIN' =
        ['SSN', 'ITIN'].includes(row.tid_kind?.toUpperCase()) ? 'SSN' : 'EIN';
      // Form-type resolution: explicit column wins, otherwise infer from tid_kind.
      const explicitForm = validateFormType(row.form);
      const entityData: Record<string, any> = {
        request_id: req.id,
        entity_name: row.legal_name,
        tid: row.tid,
        tid_kind: resolvedTidKind,
        address: row.address || null,
        city: row.city || null,
        state: row.state || null,
        zip_code: row.zip_code || null,
        form_type: explicitForm || inferFormTypeFromTidKind(resolvedTidKind),
        years: parseYears(row.years),
        signer_first_name: row['first name'] || null,
        signer_last_name: row['last name'] || null,
        signer_email: row.email || null,
        signature_id: row.signature_id || null,
        signature_created_at: parseSignatureDate(row.signature_created_at),
        status: row.signature_id ? '8821_signed' : 'pending',
      };

      // Add entity transcript order if this row was selected
      if (entityTranscriptIndices.includes(idx)) {
        entityData.gross_receipts = {
          entity_transcript_order: {
            requested: true,
            price: RATE_ENTITY_TRANSCRIPT,
            ordered_at: new Date().toISOString(),
          },
        };
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

            try {
              const { signatureRequestId } = await sendSignatureRequest(entity, entity.signer_email);
              await admin
                .from('request_entities')
                .update({ signature_id: signatureRequestId, status: '8821_sent' })
                .eq('id', entity.id);
              console.log(`[csv-upload] 8821 sent for ${entity.entity_name} → ${entity.signer_email}`);
            } catch (sendErr) {
              console.error(`[csv-upload] Failed to send 8821 for ${entity.entity_name}:`, sendErr);
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

    return NextResponse.json({
      success: true,
      batch_id: batch.id,
      request_id: req.id,
      requests_created: 1,
      entities_created: entityCount,
      loan_numbers: [effectiveLoanNumber],
      repeat_entities: repeatEntities.length > 0 ? repeatEntities : undefined,
    });
  } catch (err) {
    console.error('CSV upload error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Upload failed' },
      { status: 500 }
    );
  }
}
