#!/usr/bin/env node
/**
 * One-shot recovery: fire 8821s for entities stuck in `pending` with a
 * signer_email but no signature_id. Mirrors the auto-send-pending cron
 * but runs locally so the 7 currently-stuck Centerstone entities get
 * unblocked immediately (don't wait for the next scheduled cron run).
 *
 * Use `--dry-run` to preview which entities would get fired.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { sendSignatureRequest } from '../lib/dropbox-sign';
import { generate8821PDF, DESIGNEES } from '../lib/8821-pdf';
import { send8821ManualSignatureEmail } from '../lib/sendgrid';

const DRY = process.argv.includes('--dry-run');
// If Dropbox Sign returns 402 (free-tier blocked from production
// signatures), fall through to email-the-PDF-directly mode.
const ENABLE_MANUAL_FALLBACK = !process.argv.includes('--no-fallback');

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

main().catch(e => { console.error('Fatal:', e); process.exit(1); });

async function main() {
  const { data: candidates, error } = await sb
    .from('request_entities')
    .select(`
      id, entity_name, form_type, tid, tid_kind,
      signer_email, signer_first_name, signer_last_name,
      address, city, state, zip_code, created_at,
      requests!inner(id, loan_number, status)
    `)
    .eq('status', 'pending')
    .not('signer_email', 'is', null)
    .is('signature_id', null)
    // Include any non-terminal parent request — covers the case where a
    // sibling entity already had its 8821 fired (parent advanced to
    // 8821_sent) but this entity is still pending (e.g. MaxMart 18038 →
    // 922 Kilburn fired, Ashvin K Patel pending).
    .not('requests.status', 'in', '("cancelled","completed","failed")')
    .order('created_at', { ascending: true }) as { data: any[] | null; error: any };

  if (error) { console.error('Query error:', error); process.exit(1); }

  console.log(`Found ${candidates?.length || 0} pending entities with signer_email + no signature_id`);
  if (!candidates || candidates.length === 0) return;

  for (const e of candidates) {
    const days = Math.floor((Date.now() - new Date(e.created_at).getTime()) / 86400000);
    console.log(`\n[${days}d] ${e.entity_name}  loan=${e.requests?.loan_number}  signer=${e.signer_email}`);
    if (DRY) { console.log('  DRY — would fire'); continue; }
    try {
      const sig = await sendSignatureRequest(
        {
          id: e.id,
          entity_name: e.entity_name,
          form_type: e.form_type,
          tid: e.tid,
          tid_kind: e.tid_kind,
          signer_first_name: e.signer_first_name,
          signer_last_name: e.signer_last_name,
          address: e.address,
          city: e.city,
          state: e.state,
          zip_code: e.zip_code,
        },
        e.signer_email,
      );
      const { error: updErr } = await sb
        .from('request_entities')
        .update({
          status: '8821_sent',
          signature_id: sig.signatureRequestId,
          signature_created_at: new Date().toISOString(),
        })
        .eq('id', e.id);
      if (updErr) {
        console.log(`  ⚠ Dropbox Sign succeeded but DB update failed: ${updErr.message}`);
        console.log(`  signature_id=${sig.signatureRequestId} — manual DB fix needed`);
      } else {
        await sb.from('requests').update({ status: '8821_sent' }).eq('id', e.requests.id).eq('status', 'submitted');
        console.log(`  ✓ 8821 sent · signature_id=${sig.signatureRequestId.slice(0, 16)}…`);
      }
    } catch (err: any) {
      const isPaymentRequired = err.statusCode === 402 || /payment_required/i.test(JSON.stringify(err.body || ''));
      if (isPaymentRequired && ENABLE_MANUAL_FALLBACK) {
        console.log('  ⚠ Dropbox Sign returned 402 — falling back to manual email-the-PDF flow');
        try {
          const formType = (e.form_type || '1040') as '1040' | '1065' | '1120' | '1120S';
          const designeeKey = 'matthew_parker_modern_tax';  // default designee
          const designee = (DESIGNEES as any)[designeeKey] || Object.values(DESIGNEES)[0];
          const address = [e.address, e.city, e.state, e.zip_code].filter(Boolean).join(', ');
          const pdfBytes = await generate8821PDF({
            taxpayer: { name: e.entity_name || '', tin: e.tid || '', address },
            designee,
            formType,
          });
          const signerName = [e.signer_first_name, e.signer_last_name].filter(Boolean).join(' ') || e.entity_name;
          await send8821ManualSignatureEmail({
            signerEmail: e.signer_email,
            signerName,
            entityName: e.entity_name,
            formType: e.form_type || '',
            pdfBytes,
            entityId: e.id,
          });
          await sb.from('request_entities').update({
            status: '8821_sent',
            signature_id: `MANUAL-${e.id.slice(0,8)}`,
            signature_created_at: new Date().toISOString(),
          }).eq('id', e.id);
          await sb.from('requests').update({ status: '8821_sent' }).eq('id', e.requests.id).in('status', ['submitted','pending']);
          console.log(`  ✓ MANUAL — emailed 8821 PDF directly to ${e.signer_email}`);
        } catch (fallbackErr: any) {
          console.log(`  ✗ Manual fallback also failed: ${fallbackErr.message?.slice(0, 200)}`);
        }
      } else {
        console.log(`  ✗ FAILED: ${err.message}`);
        if (err.body) console.log('    body:', JSON.stringify(err.body).slice(0, 500));
        if (err.statusCode) console.log('    statusCode:', err.statusCode);
        if (err.response?.body) console.log('    response.body:', JSON.stringify(err.response.body).slice(0, 500));
        if (err.response?.statusCode) console.log('    response.statusCode:', err.response.statusCode);
      }
    }
  }
  console.log('\n=== DONE ===');
}
