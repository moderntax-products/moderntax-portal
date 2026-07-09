/**
 * Auto-generated 8821s on new requests (2026-07-09 feature).
 *
 * When an ordering party creates a request (manual entry, CSV — any workflow
 * where a signed 8821 isn't already attached), the system generates a fully
 * populated Form 8821 per entity — taxpayer Section 1 from the fields they
 * just entered, the ModernTax house designee (DESIGNEES.default — Joel
 * Abernathy C/O ModernTax Inc) in Section 2, Section 3 from form_type +
 * years — then EMAILS the PDFs to the ordering party and stores each copy for
 * download. The requester collects signatures with their own tools and
 * uploads the signed forms back; clients that already upload signed 8821s
 * (e.g. Cal Statewide) are unaffected because entities arriving with a
 * signed_8821_url are skipped.
 *
 * One data entry → populated 8821 in the inbox instantly. (Guardian pilot ask:
 * bulk generation to avoid duplicate data entry on batch authorizations.)
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import sgMail from '@sendgrid/mail';
import { generate8821PDF, DESIGNEES } from './8821-pdf';

type Form8821Type = '1040' | '1065' | '1120' | '1120S' | '990' | '1041' | '941';

/** Map an entity's stored form_type onto a 8821-supported form type. */
function normalizeFormType(raw: string | null | undefined): Form8821Type {
  const v = (raw || '').toUpperCase();
  switch (v) {
    case '1065': return '1065';
    case '1120': return '1120';
    case '1120S': return '1120S';
    case '990': return '990';
    case '1041': return '1041';
    case '941': return '941';
    case 'W2_INCOME':
    case '1040':
    default:
      return '1040';
  }
}

/** Same Section 3 year formatting rule the admin generator uses. */
function formatYears(years: number[]): string {
  if (!years || years.length === 0) return '2022-2026';
  const sorted = [...new Set(years)].sort((a, b) => a - b);
  if (sorted.length === 1) return String(sorted[0]);
  const contiguous = sorted.every((y, i) => i === 0 || y === sorted[i - 1] + 1);
  if (contiguous) return `${sorted[0]}-${sorted[sorted.length - 1]}`;
  const list = sorted.join(', ');
  if (list.length <= 21) return list;
  return `${sorted[0]}-${sorted[sorted.length - 1]}`;
}

export interface AutoGen8821Result {
  generated: Array<{ entityId: string; entityName: string; storagePath: string }>;
  skipped: Array<{ entityId: string; entityName: string; reason: string }>;
  emailed: boolean;
  emailedTo: string | null;
}

/**
 * Generate a populated 8821 for every entity on the request that doesn't
 * already have a signed one, store each at 8821/{entityId}/{ts}-prefilled.pdf
 * (pointer in gross_receipts.prefilled_8821_url — signed_8821_url is never
 * touched), and email the set to `recipientEmail`. Idempotent enough for
 * retries: regenerating just adds a fresh timestamped copy.
 */
export async function autoGenerate8821sForRequest(
  admin: SupabaseClient,
  requestId: string,
  recipient: { email: string; name?: string | null },
): Promise<AutoGen8821Result> {
  const result: AutoGen8821Result = { generated: [], skipped: [], emailed: false, emailedTo: null };

  const { data: req } = await admin.from('requests')
    .select('id, loan_number, clients(name)')
    .eq('id', requestId).single() as { data: any };
  if (!req) return result;

  const { data: entities } = await admin.from('request_entities')
    .select('id, entity_name, tid, tid_kind, form_type, years, address, city, state, zip_code, signed_8821_url, gross_receipts')
    .eq('request_id', requestId) as { data: any[] | null };

  const attachments: Array<{ content: string; filename: string; type: string; disposition: 'attachment' }> = [];

  for (const e of entities || []) {
    if (e.signed_8821_url) { result.skipped.push({ entityId: e.id, entityName: e.entity_name, reason: 'signed 8821 already attached' }); continue; }
    if ((e.form_type || '').toUpperCase() === 'W2_INCOME') { result.skipped.push({ entityId: e.id, entityName: e.entity_name, reason: 'W&I — no 8821 needed' }); continue; }
    if (!e.tid) { result.skipped.push({ entityId: e.id, entityName: e.entity_name, reason: 'no TIN on entity' }); continue; }

    try {
      const cityStateZip = [[e.city, e.state].filter(Boolean).join(', '), e.zip_code].filter(Boolean).join(' ').trim();
      const address = [e.address, cityStateZip].filter(Boolean).join('\n');
      const yearsArr: number[] = (e.years || []).map((y: any) => parseInt(String(y), 10)).filter(Number.isFinite);

      const pdf = await generate8821PDF({
        taxpayer: { name: e.entity_name || '', tin: e.tid || '', address },
        designee: DESIGNEES.default,
        formType: normalizeFormType(e.form_type),
        years: formatYears(yearsArr),
      });
      const buf = Buffer.from(pdf);

      const storagePath = `8821/${e.id}/${Date.now()}-prefilled.pdf`;
      const { error: upErr } = await admin.storage.from('uploads')
        .upload(storagePath, buf, { contentType: 'application/pdf', upsert: false });
      if (!upErr) {
        await (admin.from('request_entities') as any)
          .update({ gross_receipts: { ...(e.gross_receipts || {}), prefilled_8821_url: storagePath, prefilled_8821_at: new Date().toISOString() } })
          .eq('id', e.id);
      }

      const safeName = (e.entity_name || 'entity').replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 40);
      attachments.push({ content: buf.toString('base64'), filename: `8821-${safeName}.pdf`, type: 'application/pdf', disposition: 'attachment' });
      result.generated.push({ entityId: e.id, entityName: e.entity_name, storagePath: upErr ? '(storage failed — emailed only)' : storagePath });
    } catch (err: any) {
      console.error(`[8821-autogen] generate failed for ${e.entity_name}:`, err?.message);
      result.skipped.push({ entityId: e.id, entityName: e.entity_name, reason: `generation failed: ${err?.message}` });
    }
  }

  if (attachments.length === 0) return result;

  // ── Email the populated forms to the ordering party (generic copy — this
  // serves lending, insurance, and every other vertical alike). ──────────────
  if (!process.env.SENDGRID_API_KEY || !recipient.email) return result;
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);

  const firstName = (recipient.name || '').split(' ')[0] || 'there';
  const n = attachments.length;
  const rows = result.generated.map(g => `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;font-size:13px;">${g.entityName}</td></tr>`).join('');
  const refLabel = req.loan_number ? ` (ref ${req.loan_number})` : '';

  try {
    await sgMail.send({
      to: recipient.email,
      from: { email: 'no-reply@moderntax.io', name: 'ModernTax' },
      replyTo: 'matt@moderntax.io',
      subject: `Your ${n === 1 ? 'Form 8821 is' : `${n} Forms 8821 are`} ready for signature${refLabel}`,
      text: `Hi ${firstName},\n\nAttached ${n === 1 ? 'is the populated Form 8821' : `are ${n} populated Forms 8821`} for the request you just submitted${refLabel}. Each form is pre-filled from the information you entered — taxpayer details, authorization periods, and the ModernTax designee — so your client only needs to sign.\n\nNext step: send each form to the taxpayer for signature using whatever e-sign or signing process your team already uses, then upload the signed copy to the request in the portal. We'll take it from there.\n\nCopies are also available for download on each entity in the portal.\n\n— ModernTax`,
      html: `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:#1a2845;font-size:14px;line-height:1.55;">
<p>Hi ${firstName},</p>
<p>Attached ${n === 1 ? 'is the populated <b>Form 8821</b>' : `are <b>${n} populated Forms 8821</b>`} for the request you just submitted${refLabel}. Each form is pre-filled from the information you entered — taxpayer details, authorization periods, and the ModernTax designee — so your client only needs to <b>sign</b>.</p>
<table style="border-collapse:collapse;border:1px solid #e5e7eb;margin:10px 0;">${rows}</table>
<p><b>Next step:</b> send each form to the taxpayer for signature using whatever signing process your team already uses, then upload the signed copy to the request in the portal. We'll take it from there.</p>
<p style="color:#6b7280;font-size:12px;">Copies are also available for download on each entity in the portal. Enter the details once — the paperwork is handled.</p>
<p>— ModernTax</p></div>`,
      attachments,
    });
    result.emailed = true;
    result.emailedTo = recipient.email;
    console.log(`[8821-autogen] emailed ${n} populated 8821(s) for request ${requestId} to ${recipient.email}`);
  } catch (err: any) {
    console.error('[8821-autogen] email failed (PDFs still stored):', err?.message);
  }

  return result;
}
