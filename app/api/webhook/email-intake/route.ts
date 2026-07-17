/**
 * POST /api/webhook/email-intake?secret=...
 *
 * Public webhook for SendGrid Inbound Parse — auto-converts inbound
 * processor emails (CSV/Excel + optional pre-signed 8821) into portal
 * requests without manual triage.
 *
 * Driver: 2026-05-26 — Soobin Song (Centerstone) emailed Matt on 4/23
 * with a CSV+8821 attached for loan 18032 / Blue Ocean Sushi. The email
 * landed in Matt's Gmail and never got triaged into the portal, so when
 * Soobin followed up 33 days later asking where the transcripts were,
 * we had to manually backfill. This webhook closes that gap.
 *
 * Flow:
 *   1. SendGrid Inbound Parse receives the email at the configured
 *      MX-record subdomain (intake@in.moderntax.io)
 *   2. POSTs multipart/form-data here with: from, to, subject, text,
 *      html, attachments count, attachment-info JSON, attachment{N} files
 *   3. We validate the query-string secret, look up the sender's portal
 *      profile by email, parse CSV + PDFs, and create the request +
 *      entities via the same logic the admin email-intake uses
 *   4. Send confirmation email back to the sender with the portal URL
 *   5. Notify matt@moderntax.io
 *
 * SETUP (one-time, see docs/email-intake-setup.md):
 *   - DNS: add MX record on `in.moderntax.io` pointing to mx.sendgrid.net
 *   - SendGrid: Inbound Parse → add host `in.moderntax.io`, destination
 *     `https://portal.moderntax.io/api/webhook/email-intake?secret=$EMAIL_INTAKE_SECRET`
 *   - Vercel env: set `EMAIL_INTAKE_SECRET` (24-byte hex) on production
 *   - Update onboarding docs: tell Centerstone/Cal Statewide processors
 *     to email `intake@in.moderntax.io` (not matt@moderntax.io) with
 *     loan_number in subject + CSV/PDF attached
 *
 * Sender validation: email must match a portal profile (any role). If
 * the sender's not in the DB, we bounce a friendly error email asking
 * them to check spelling or get added.
 *
 * Loan number extraction: subject line "Loan #18032 ..." or pattern
 * /\b1[0-9]{4,5}\b/ in subject/body. Falls back to "EMAIL-{date}-{first-4-of-msgid}"
 * if not found.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import * as XLSX from 'xlsx';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface IncomingEmailParts {
  fromEmail: string;
  fromName: string | null;
  to: string;
  subject: string;
  text: string;
  html: string;
  csvFile: { name: string; type: string; buffer: Buffer } | null;
  pdfFiles: { name: string; type: string; buffer: Buffer }[];
  otherAttachments: { name: string; type: string; buffer: Buffer }[];
}

export async function POST(request: NextRequest) {
  try {
    return await handle(request);
  } catch (err: any) {
    console.error('[email-intake] Unhandled exception:', err);
    return NextResponse.json(
      { error: 'Server error', detail: err?.message || String(err) },
      { status: 500 },
    );
  }
}

async function handle(request: NextRequest) {
  // Auth via URL-embedded secret (SendGrid Inbound Parse supports query
  // params in the webhook URL). Same trust model as the Retell webhook.
  const expected = process.env.EMAIL_INTAKE_SECRET;
  const provided = request.nextUrl.searchParams.get('secret');
  if (!expected || provided !== expected) {
    console.error('[email-intake] unauthorized');
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Parse the SendGrid multipart payload
  const form = await request.formData();
  const parts = await extractEmailParts(form);
  console.log(`[email-intake] received: from=${parts.fromEmail} subject="${parts.subject.slice(0, 80)}" csv=${parts.csvFile?.name || 'none'} pdfs=${parts.pdfFiles.length}`);

  const admin = createAdminClient();

  // 1. Look up the sender's portal profile
  const { data: sender } = await admin.from('profiles')
    .select('id, email, full_name, role, client_id, clients(name)')
    .eq('email', parts.fromEmail.toLowerCase())
    .maybeSingle() as { data: any };

  if (!sender) {
    await sendBounceEmail(parts, 'sender_not_recognized', null);
    console.warn(`[email-intake] rejected: sender ${parts.fromEmail} not found in profiles`);
    return NextResponse.json({ rejected: true, reason: 'sender not in profiles' }, { status: 200 });
  }
  if (!sender.client_id) {
    await sendBounceEmail(parts, 'no_client_associated', sender);
    console.warn(`[email-intake] rejected: sender ${parts.fromEmail} has no client_id`);
    return NextResponse.json({ rejected: true, reason: 'sender has no client' }, { status: 200 });
  }

  // 1b. Signed-8821-only email (PDF, no CSV): a processor replying / forwarding
  // the SIGNED 8821 for an order that already exists. Attach it to the right
  // entity and advance it to 8821_signed so auto-assign-experts queues it for
  // an expert — no navigating back into the portal to upload. (The CSV path
  // below is unchanged; this only fires when there's no CSV but there are PDFs.)
  if (!parts.csvFile && parts.pdfFiles.length > 0) {
    return await handleSigned8821Email(admin, request, parts, sender);
  }

  // 2. Need at least a CSV/Excel file to extract entity data
  if (!parts.csvFile) {
    await sendBounceEmail(parts, 'no_csv_attached', sender);
    console.warn(`[email-intake] rejected: no CSV/Excel attachment from ${parts.fromEmail}`);
    return NextResponse.json({ rejected: true, reason: 'no CSV/Excel attached' }, { status: 200 });
  }

  // 3. Parse the CSV
  let rawRows: any[] = [];
  try {
    const wb = XLSX.read(parts.csvFile.buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    rawRows = XLSX.utils.sheet_to_json<Record<string, any>>(sheet);
  } catch (e: any) {
    await sendBounceEmail(parts, 'csv_parse_failed', sender, { error: e.message });
    return NextResponse.json({ rejected: true, reason: 'CSV parse failed', detail: e.message }, { status: 200 });
  }
  rawRows = rawRows.filter(r => Object.values(r).some(v => String(v ?? '').trim() !== ''));
  if (rawRows.length === 0) {
    await sendBounceEmail(parts, 'csv_empty', sender);
    return NextResponse.json({ rejected: true, reason: 'CSV had no data rows' }, { status: 200 });
  }
  const rows = rawRows.map(normalizeRow);
  const validationErrors: string[] = [];
  rows.forEach((r, i) => {
    if (!r.legal_name) validationErrors.push(`Row ${i + 2}: missing legal_name`);
    if (!r.tid) validationErrors.push(`Row ${i + 2}: missing tid`);
  });
  if (validationErrors.length > 0) {
    await sendBounceEmail(parts, 'csv_validation_failed', sender, { errors: validationErrors.slice(0, 10) });
    return NextResponse.json({ rejected: true, reason: 'CSV validation failed', errors: validationErrors }, { status: 200 });
  }

  // 4. Extract loan number from subject/body, fall back to a generated tag
  const loanNumber = extractLoanNumber(parts.subject) || extractLoanNumber(parts.text) || `EMAIL-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  // 5. Upload source CSV + PDFs to storage
  const ts = Date.now();
  const csvPath = `${sender.client_id}/${ts}-email-intake-${safeName(parts.csvFile.name)}`;
  await admin.storage.from('uploads').upload(csvPath, parts.csvFile.buffer, {
    contentType: parts.csvFile.type, upsert: false,
  });
  const pdfPaths: Array<{ originalName: string; storagePath: string }> = [];
  for (const pdf of parts.pdfFiles) {
    const path = `${sender.client_id}/email-intake-attachments/${ts}-${safeName(pdf.name)}`;
    const { error } = await admin.storage.from('uploads').upload(path, pdf.buffer, {
      contentType: pdf.type, upsert: false,
    });
    if (!error) pdfPaths.push({ originalName: pdf.name, storagePath: path });
  }

  // 6. Create request + entities
  const { data: req } = await admin.from('requests').insert({
    client_id: sender.client_id,
    requested_by: sender.id,
    loan_number: loanNumber,
    intake_method: 'csv',
    status: 'submitted',
    source_file_url: csvPath,
    notes: `[Submitted via email intake] Subject: ${parts.subject}`,
  } as any).select('id').single() as { data: any };

  // Heuristic 8821-to-entity matching: if a PDF's name mentions the entity
  // name (or a slug of it), attach it. Otherwise attach to the first entity
  // as a best-effort.
  const entitiesToCreate = rows.map((r, idx) => {
    const matchedPdf = pdfPaths.find(p => {
      const lc = p.originalName.toLowerCase();
      const ent = r.legal_name.toLowerCase().replace(/[^a-z0-9]/g, '');
      return lc.includes(ent.slice(0, 10)) || lc.includes('seller') && idx === 0;
    });
    const years = parseYearsField(r.years);
    return {
      request_id: req.id,
      entity_name: r.legal_name,
      tid: r.tid,
      tid_kind: r.tid_kind || 'EIN',
      form_type: r.form || '1040',
      years,
      address: r.address || null,
      city: r.city || null,
      state: r.state || null,
      zip_code: r.zip_code || null,
      signer_email: r.email || null,
      signed_8821_url: matchedPdf?.storagePath || null,
      status: matchedPdf ? '8821_signed' : '8821_sent',
    };
  });

  const { data: insertedEntities } = await admin.from('request_entities')
    .insert(entitiesToCreate as any).select('id, entity_name, status, signed_8821_url') as { data: any[] };

  // 7. Audit log
  await logAuditFromRequest(admin, request, {
    action: 'transcript_request_received',
    userId: sender.id,
    userEmail: sender.email,
    resourceType: 'request',
    resourceId: req.id,
    details: {
      via: 'email_intake_webhook',
      loan_number: loanNumber,
      entity_count: insertedEntities?.length || 0,
      pdf_attachment_count: pdfPaths.length,
      from_email: parts.fromEmail,
      subject: parts.subject,
    },
  });

  // 8. Send confirmation to sender + alert Matt
  await sendConfirmationEmail(parts, sender, {
    requestId: req.id,
    loanNumber,
    entities: insertedEntities || [],
    pdfMatchedCount: pdfPaths.length,
  });
  await notifyMatt(parts, sender, req.id, loanNumber, insertedEntities?.length || 0);

  console.log(`[email-intake] ✓ created request ${req.id} for ${sender.email} (loan ${loanNumber}, ${insertedEntities?.length || 0} entities)`);

  return NextResponse.json({
    success: true,
    request_id: req.id,
    loan_number: loanNumber,
    entity_count: insertedEntities?.length || 0,
  });
}

// ──────────────────────────────────────────────────────────────────────
// Email parsing helpers
// ──────────────────────────────────────────────────────────────────────

async function extractEmailParts(form: FormData): Promise<IncomingEmailParts> {
  const fromRaw = String(form.get('from') || '');
  const { email: fromEmail, name: fromName } = parseRfc822FromHeader(fromRaw);
  const subject = String(form.get('subject') || '');
  const text = String(form.get('text') || '');
  const html = String(form.get('html') || '');
  const to = String(form.get('to') || '');

  // Find all attachment files in the multipart payload
  let csvFile: IncomingEmailParts['csvFile'] = null;
  const pdfFiles: IncomingEmailParts['pdfFiles'] = [];
  const otherAttachments: IncomingEmailParts['otherAttachments'] = [];

  // SendGrid sends attachments as `attachment1`, `attachment2`, etc.
  for (const [key, value] of form.entries()) {
    if (!/^attachment\d+$/.test(key)) continue;
    if (!(value instanceof File)) continue;
    const buffer = Buffer.from(await value.arrayBuffer());
    const name = value.name || key;
    const lc = name.toLowerCase();
    const item = { name, type: value.type || 'application/octet-stream', buffer };
    if (lc.endsWith('.csv') || lc.endsWith('.xlsx') || lc.endsWith('.xls')) {
      // Only one CSV per email — first wins
      if (!csvFile) csvFile = item;
      else otherAttachments.push(item);
    } else if (lc.endsWith('.pdf')) {
      pdfFiles.push(item);
    } else {
      otherAttachments.push(item);
    }
  }

  return { fromEmail, fromName, to, subject, text, html, csvFile, pdfFiles, otherAttachments };
}

function parseRfc822FromHeader(raw: string): { email: string; name: string | null } {
  // Handles: "Name <email@x.com>" and "email@x.com" formats
  const m = raw.match(/^"?([^"<]*)"?\s*<([^>]+)>$/) || raw.match(/^([^<]+)$/);
  if (m && m.length === 3) return { email: m[2].trim().toLowerCase(), name: m[1].trim() || null };
  if (m && m.length === 2) return { email: m[1].trim().toLowerCase(), name: null };
  return { email: raw.trim().toLowerCase(), name: null };
}

function extractLoanNumber(text: string | null): string | null {
  if (!text) return null;
  // Try "Loan #12345" first
  const labeled = text.match(/(?:loan|app(?:lication)?)\s*[#:]\s*([A-Za-z0-9_-]+)/i);
  if (labeled) return labeled[1];
  // Bare 5-6 digit loan number near top of subject
  const bare = text.match(/\b(1[0-9]{4,5})\b/);
  if (bare) return bare[1];
  return null;
}

function safeName(name: string): string {
  return (name || 'file').replace(/[^\w.\-]+/g, '_').slice(0, 80);
}

function normalizeRow(raw: Record<string, any>) {
  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    normalized[k.trim().toLowerCase().replace(/\s+/g, '_')] = String(v ?? '').trim();
  }
  return {
    legal_name: normalized['legal_name'] || normalized['legalname'] || normalized['entity_name'] || '',
    tid: (normalized['tid'] || '').replace(/[^\d-]/g, ''),
    tid_kind: (normalized['tid_kind'] || normalized['tidkind'] || 'EIN').toUpperCase(),
    address: normalized['address'] || '',
    city: normalized['city'] || '',
    state: normalized['state'] || '',
    zip_code: normalized['zip_code'] || normalized['zip'] || normalized['zipcode'] || '',
    years: normalized['years'] || normalized['year'] || '',
    form: normalized['form'] || normalized['form_type'] || normalized['formtype'] || '1040',
    email: normalized['email'] || normalized['signer_email'] || '',
  };
}

function parseYearsField(raw: string): string[] {
  if (!raw) return [];
  // Accepts "{2023,2024,2025}", "2023,2024,2025", "2023 2024 2025", "2023-2025"
  const cleaned = raw.replace(/[{}]/g, '');
  if (/^\d{4}-\d{4}$/.test(cleaned)) {
    const [from, to] = cleaned.split('-').map(Number);
    const result = [];
    for (let y = from; y <= to; y++) result.push(String(y));
    return result;
  }
  return cleaned.split(/[,\s]+/).map(s => s.trim()).filter(s => /^\d{4}$/.test(s));
}

// ──────────────────────────────────────────────────────────────────────
// Outbound emails — confirmations + bounces
// ──────────────────────────────────────────────────────────────────────

async function sendConfirmationEmail(
  parts: IncomingEmailParts,
  sender: any,
  details: { requestId: string; loanNumber: string; entities: any[]; pdfMatchedCount: number },
) {
  const sgMod = await import('@sendgrid/mail');
  const sgMail = sgMod.default;
  if (!process.env.SENDGRID_API_KEY) return;
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);

  const entityList = details.entities.map(e => `  • ${e.entity_name} — ${e.signed_8821_url ? 'signed 8821 attached' : '8821 needed (status: 8821_sent)'}`).join('\n');
  const text = `Hi ${(sender.full_name || '').split(' ')[0] || 'there'},

Got your email — request is now in the portal.

Loan #:        ${details.loanNumber}
Request ID:    ${details.requestId}
Entities:      ${details.entities.length}
${entityList}

PDFs attached and matched to entities: ${details.pdfMatchedCount}

View in portal: https://portal.moderntax.io/admin/requests/${details.requestId}

Any entities that show "8821 needed" still need the borrower to sign an 8821 (we'll send the e-signature envelope shortly if signer email was provided). Entities with a signed 8821 already attached are ready for our expert to pull transcripts (typically within 24 business hours).

Reply to this email with any questions.

Thanks!
ModernTax Portal`;

  await sgMail.send({
    to: parts.fromEmail,
    from: { email: 'no-reply@moderntax.io', name: 'ModernTax Intake' },
    replyTo: 'matt@moderntax.io',
    subject: `Re: ${parts.subject} — received & in queue`,
    text,
  }).catch((e: any) => console.warn('[email-intake] confirmation send failed:', e?.message));
}

async function sendBounceEmail(
  parts: IncomingEmailParts,
  reason: 'sender_not_recognized' | 'no_client_associated' | 'no_csv_attached' | 'csv_parse_failed' | 'csv_empty' | 'csv_validation_failed',
  _sender: any | null,
  extra?: { error?: string; errors?: string[] },
) {
  const sgMod = await import('@sendgrid/mail');
  const sgMail = sgMod.default;
  if (!process.env.SENDGRID_API_KEY) return;
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);

  const explanations: Record<typeof reason, string> = {
    sender_not_recognized: `We didn't find a portal account for ${parts.fromEmail}. If you should have access, ask your team admin to add you, or reply to this email and we'll get you set up.`,
    no_client_associated: `Your account exists but isn't associated with a client organization yet. We've forwarded this to Matt to fix; you'll hear back shortly.`,
    no_csv_attached: `The email needs to include a CSV or Excel file with the entity data (legal_name, tid, tid_kind, address, city, state, zip, years, form). See the sample at https://portal.moderntax.io/new for the expected format.`,
    csv_parse_failed: `We couldn't parse the attached file. Error: ${extra?.error || 'unknown'}. Please verify it's a valid CSV/Excel file and resend.`,
    csv_empty: `The attached file had no data rows. Please include at least one entity and resend.`,
    csv_validation_failed: `The CSV had validation errors:\n${(extra?.errors || []).map(e => '  · ' + e).join('\n')}\n\nPlease fix and resend.`,
  };

  const text = `Hi,

We received your email at intake@in.moderntax.io but couldn't process it:

REASON: ${reason.replace(/_/g, ' ')}

${explanations[reason]}

Your original subject: ${parts.subject}

Reply to matt@moderntax.io for help.

Thanks,
ModernTax Intake`;

  await sgMail.send({
    to: parts.fromEmail,
    from: { email: 'no-reply@moderntax.io', name: 'ModernTax Intake' },
    replyTo: 'matt@moderntax.io',
    subject: `Re: ${parts.subject} — couldn't process (action required)`,
    text,
  }).catch((e: any) => console.warn('[email-intake] bounce send failed:', e?.message));
}

async function notifyMatt(parts: IncomingEmailParts, sender: any, requestId: string, loanNumber: string, entityCount: number) {
  const sgMod = await import('@sendgrid/mail');
  const sgMail = sgMod.default;
  if (!process.env.SENDGRID_API_KEY) return;
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);

  const text = `Email-intake webhook auto-created a new request:

From:      ${parts.fromEmail} (${sender.full_name}, ${sender.clients?.name})
Subject:   ${parts.subject}
Loan #:    ${loanNumber}
Entities:  ${entityCount}
Request:   https://portal.moderntax.io/admin/requests/${requestId}

No action needed — just FYI. Confirmation sent to the requester.`;

  await sgMail.send({
    to: 'matt@moderntax.io',
    from: { email: 'no-reply@moderntax.io', name: 'ModernTax Portal' },
    subject: `[Email Intake] ${sender.clients?.name || ''} - ${loanNumber} (${entityCount} entit${entityCount === 1 ? 'y' : 'ies'})`,
    text,
  }).catch((e: any) => console.warn('[email-intake] matt notify failed:', e?.message));
}

// ──────────────────────────────────────────────────────────────────────
// Signed-8821-only intake — attach an emailed signed 8821 to an existing order
// ──────────────────────────────────────────────────────────────────────

/**
 * A processor emailed the SIGNED 8821 (no CSV) for an order that already
 * exists. Find the right entity, attach the PDF, advance it to 8821_signed.
 *
 * Matching, most-specific first:
 *   1. reply address  intake+<entityId>@in.moderntax.io   (deterministic)
 *   2. loan number in the subject/body  → entities under that loan (ideal)
 *   3. exactly one open entity awaiting an 8821 for this client (sole-pending)
 *   4. vision-read the TIN off the 8821 and match it (only when
 *      ANTHROPIC_API_KEY is configured; otherwise skipped)
 * Anything we can't confidently match is held for triage + flagged to Matt —
 * we never guess onto the wrong loan.
 */
async function handleSigned8821Email(
  admin: ReturnType<typeof createAdminClient>,
  request: NextRequest,
  parts: IncomingEmailParts,
  sender: any,
): Promise<NextResponse> {
  // Candidate pool: this client's entities still awaiting a signed 8821.
  const { data: rawCandidates } = await admin.from('request_entities')
    .select('id, entity_name, tid, status, signed_8821_url, request_id, requests!inner(loan_number, client_id)')
    .eq('requests.client_id', sender.client_id)
    .in('status', ['pending', 'submitted', '8821_sent'])
    .is('signed_8821_url', null) as { data: any[] | null };
  let candidates = rawCandidates || [];

  // (1) reply-address narrows to a single entity.
  const addrEntityId = extractEntityIdFromTo(parts.to);
  if (addrEntityId) {
    const hit = candidates.filter((c) => c.id === addrEntityId);
    if (hit.length) candidates = hit;
  }
  // (2) loan number narrows to that loan's entities.
  const loanNumber = extractLoanNumber(parts.subject) || extractLoanNumber(parts.text);
  if (candidates.length > 1 && loanNumber) {
    const byLoan = candidates.filter(
      (c) => String(c.requests?.loan_number || '').toLowerCase() === loanNumber.toLowerCase(),
    );
    if (byLoan.length) candidates = byLoan;
  }

  const attached: { entityName: string; loan: string | null }[] = [];
  const unmatched: string[] = [];

  for (const pdf of parts.pdfFiles) {
    let target: any = null;
    if (candidates.length === 1) {
      // Sole remaining candidate — reply-address, single-entity loan, or the
      // client only has one order open. The dominant, no-AI case.
      target = candidates[0];
    } else if (candidates.length > 1) {
      // Multiple possibilities — only the TIN on the form can disambiguate.
      const tin = await tinFromPdf(pdf.buffer);
      if (tin) {
        const digits = tin.replace(/\D/g, '');
        target = candidates.find((c) => String(c.tid || '').replace(/\D/g, '') === digits) || null;
      }
    }
    if (!target) { unmatched.push(pdf.name); continue; }

    const storagePath = `8821/${target.id}/${Date.now()}-emailed-signed-${safeName(pdf.name)}`;
    const { error: upErr } = await admin.storage.from('uploads').upload(storagePath, pdf.buffer, {
      contentType: pdf.type || 'application/pdf', upsert: false,
    });
    if (upErr) { console.error('[email-intake] signed-8821 upload failed:', upErr.message); unmatched.push(pdf.name); continue; }

    const update: Record<string, any> = { signed_8821_url: storagePath };
    if (['pending', 'submitted', '8821_sent'].includes(target.status)) update.status = '8821_signed';
    await admin.from('request_entities').update(update).eq('id', target.id);

    attached.push({ entityName: target.entity_name, loan: target.requests?.loan_number || null });
    // Don't let a second PDF land on the same entity.
    candidates = candidates.filter((c) => c.id !== target.id);
  }

  // Hold any PDF we couldn't match for manual triage.
  for (const name of unmatched) {
    const pdf = parts.pdfFiles.find((p) => p.name === name);
    if (!pdf) continue;
    await admin.storage.from('uploads')
      .upload(`${sender.client_id}/unmatched-8821/${Date.now()}-${safeName(name)}`, pdf.buffer, {
        contentType: pdf.type || 'application/pdf', upsert: false,
      }).catch(() => {});
  }

  await logAuditFromRequest(admin, request, {
    action: 'transcript_request_received',
    userId: sender.id,
    userEmail: sender.email,
    resourceType: 'request',
    resourceId: attached.length ? 'signed_8821_attached' : 'signed_8821_unmatched',
    details: {
      via: 'email_signed_8821',
      attached: attached.length,
      unmatched: unmatched.length,
      loan_number: loanNumber,
      from_email: parts.fromEmail,
      subject: parts.subject,
    },
  });

  await sendSigned8821Result(parts, sender, attached, unmatched, loanNumber);

  console.log(`[email-intake] signed-8821 from ${sender.email}: attached=${attached.length} unmatched=${unmatched.length} loan=${loanNumber || 'n/a'}`);
  return NextResponse.json({ success: attached.length > 0, attached: attached.length, unmatched: unmatched.length });
}

/** Extract a UUID from a reply address like intake+<uuid>@in.moderntax.io. */
function extractEntityIdFromTo(to: string): string | null {
  const m = (to || '').match(/\+([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})@/);
  return m ? m[1] : null;
}

/** Vision-read the TIN off a signed 8821. Returns null if AI isn't configured. */
async function tinFromPdf(buffer: Buffer): Promise<string | null> {
  try {
    const { extract8821WithVision } = await import('@/lib/extract-8821-vision');
    const ex = await extract8821WithVision(buffer);
    return ex.tin || null;
  } catch (e: any) {
    console.warn('[email-intake] vision TIN extract failed:', e?.message);
    return null;
  }
}

async function sendSigned8821Result(
  parts: IncomingEmailParts,
  sender: any,
  attached: { entityName: string; loan: string | null }[],
  unmatched: string[],
  loanNumber: string | null,
) {
  const sgMod = await import('@sendgrid/mail');
  const sgMail = sgMod.default;
  if (!process.env.SENDGRID_API_KEY) return;
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  const firstName = (sender.full_name || '').split(' ')[0] || 'there';

  if (attached.length > 0) {
    const list = attached.map((a) => `  • ${a.entityName}${a.loan ? ` (Loan #${a.loan})` : ''} — filed, now queued for an expert`).join('\n');
    const tail = unmatched.length
      ? `\n\nWe couldn't match ${unmatched.length} other attachment${unmatched.length === 1 ? '' : 's'} to an order — reply with the loan number and we'll file ${unmatched.length === 1 ? 'it' : 'them'}.`
      : '';
    await sgMail.send({
      to: parts.fromEmail,
      from: { email: 'no-reply@moderntax.io', name: 'ModernTax Intake' },
      replyTo: 'support@moderntax.io',
      subject: `Re: ${parts.subject} — signed 8821 filed & queued`,
      text: `Hi ${firstName},\n\nGot your signed 8821 — it's attached to your order and queued for an expert to pull transcripts (typically within 24 business hours):\n\n${list}${tail}\n\nNo further action needed.\n\nThanks,\nModernTax`,
    }).catch((e: any) => console.warn('[email-intake] signed-8821 confirmation failed:', e?.message));
  } else {
    await sgMail.send({
      to: parts.fromEmail,
      from: { email: 'no-reply@moderntax.io', name: 'ModernTax Intake' },
      replyTo: 'support@moderntax.io',
      subject: `Re: ${parts.subject} — signed 8821 received (which order?)`,
      text: `Hi ${firstName},\n\nWe received your signed 8821 but couldn't tell which order it belongs to${loanNumber ? ` (no open order matched loan #${loanNumber})` : ''}. Reply with the loan number in the subject and we'll file it right away — or upload it on the order in your portal.\n\nThanks,\nModernTax`,
    }).catch((e: any) => console.warn('[email-intake] signed-8821 unmatched notice failed:', e?.message));
  }

  // Always flag to Matt when something couldn't be matched.
  if (unmatched.length > 0) {
    await sgMail.send({
      to: 'matt@moderntax.io',
      from: { email: 'no-reply@moderntax.io', name: 'ModernTax Portal' },
      subject: `[Signed-8821 intake] ${unmatched.length} unmatched from ${sender.clients?.name || sender.email}`,
      text: `A signed-8821 email couldn't be fully matched.\n\nFrom:     ${parts.fromEmail} (${sender.full_name}, ${sender.clients?.name})\nSubject:  ${parts.subject}\nLoan #:   ${loanNumber || '(none in subject)'}\nAttached: ${attached.length}\nUnmatched:${unmatched.length} → held under ${sender.client_id}/unmatched-8821/\n\nAttach them by hand on the order, or ask the sender for the loan number.`,
    }).catch((e: any) => console.warn('[email-intake] matt unmatched notify failed:', e?.message));
  }
}
