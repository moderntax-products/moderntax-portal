#!/usr/bin/env node
/**
 * One-off — pull the current state of the TaxTaker trial entity
 * (Mento Technologies) so Matt can ground his reply to Ari Salafia
 * in actual per-quarter data instead of recapping from memory.
 *
 * Reports:
 *   - Entity row (form_type, status, completed_at, signed_8821_url)
 *   - All transcripts on file (transcript_urls + transcript_html_urls)
 *   - Any ERC analysis stored in gross_receipts JSONB
 *   - Check-reissue request rows (if any have already been requested)
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const env = Object.fromEntries(
  envText.split('\n')
    .filter(l => l && !l.trim().startsWith('#') && l.includes('='))
    .map(l => {
      const eq = l.indexOf('=');
      return [l.slice(0, eq).trim(), l.slice(eq + 1).trim().replace(/^["']|["']$/g, '')];
    })
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// 1) Find by entity name
const { data: byName } = await sb
  .from('request_entities')
  .select('id, entity_name, form_type, status, completed_at, tid, signer_email, transcript_urls, transcript_html_urls, gross_receipts, signed_8821_url, signature_created_at, request_id, requests:request_id(loan_number, client_id, clients(name))')
  .ilike('entity_name', '%mento%');

console.log(`Entities matching "%mento%": ${byName?.length || 0}`);
for (const e of (byName || [])) {
  console.log(`\n=== ${e.entity_name} (${e.requests?.clients?.name}) ===`);
  console.log(`  entity_id:        ${e.id}`);
  console.log(`  form_type:        ${e.form_type}`);
  console.log(`  status:           ${e.status}${e.completed_at ? ' (completed ' + e.completed_at + ')' : ''}`);
  console.log(`  tid:              ${e.tid}`);
  console.log(`  loan_number:      ${e.requests?.loan_number}`);
  console.log(`  signer:           ${e.signer_email}`);
  console.log(`  8821 signed:      ${e.signed_8821_url ? 'yes (' + e.signature_created_at + ')' : 'NO'}`);
  console.log(`  transcript_urls:  ${(e.transcript_urls || []).length} PDF`);
  console.log(`  transcript_html:  ${(e.transcript_html_urls || []).length} HTML`);
  if (e.transcript_html_urls?.length) {
    for (const u of e.transcript_html_urls.slice(0, 12)) {
      // Truncate the storage URL — we just want the filename for orientation
      const tail = u.split('/').slice(-1)[0].split('?')[0];
      console.log(`    · ${decodeURIComponent(tail)}`);
    }
  }
  // gross_receipts is JSONB — dump high-signal keys only
  const gr = e.gross_receipts;
  if (gr && typeof gr === 'object') {
    const keys = Object.keys(gr);
    console.log(`  gross_receipts keys: ${keys.length === 0 ? '(empty)' : keys.join(', ')}`);
    // If any key looks like ERC analysis, surface it
    for (const k of keys) {
      const v = gr[k];
      if (k.toLowerCase().includes('erc') || k.match(/^q[1-4][\s-_]?20[12][0-9]/i) || k.match(/^20[12][0-9][\s-_]?q[1-4]/i)) {
        console.log(`    [${k}] ${JSON.stringify(v).slice(0, 300)}`);
      }
    }
  }

  // 2) Check-reissue requests for this entity
  const { data: reissues } = await sb
    .from('check_reissue_requests')
    .select('id, tax_year, tax_quarter, status, payment_status, service_fee, original_refund_amount, original_refund_date, returned_undelivered_date, created_at')
    .eq('entity_id', e.id)
    .order('tax_year', { ascending: true })
    .order('tax_quarter', { ascending: true });
  console.log(`  check_reissue_requests: ${reissues?.length || 0}`);
  for (const r of (reissues || [])) {
    console.log(`    · ${r.tax_year} Q${r.tax_quarter} · status=${r.status} · payment=${r.payment_status || '—'} · fee=$${r.service_fee} · original=$${r.original_refund_amount} (issued ${r.original_refund_date}, returned ${r.returned_undelivered_date}) · id=${r.id}`);
  }

  // 3) Fetch + parse one transcript HTML to confirm Q3/Q4 2021 status
  // We pick the most-recently-uploaded HTML (assumes 941 quarterly)
  if (e.transcript_html_urls?.length) {
    const urls = e.transcript_html_urls;
    console.log(`\n  Sampling transcript HTML contents to surface Q3/Q4 2021 TC patterns…`);
    for (const u of urls) {
      const tail = decodeURIComponent(u.split('/').slice(-1)[0].split('?')[0]);
      // Only care about 941 transcripts referencing 2021
      if (!/941/i.test(tail) || !/2021/i.test(tail)) continue;
      try {
        // Storage paths look like "transcripts/<entity>/<filename>" — strip
        // the bucket prefix to download via the storage client.
        const bucketPrefix = u.match(/^([^/]+)\/(.+)$/);
        let html;
        if (bucketPrefix) {
          const [, bucket, path] = bucketPrefix;
          const { data: blob, error: dlErr } = await sb.storage.from(bucket).download(path);
          if (dlErr || !blob) { console.log(`    [${tail}] storage download err: ${dlErr?.message}`); continue; }
          html = await blob.text();
        } else {
          const r = await fetch(u);
          if (!r.ok) { console.log(`    [${tail}] fetch ${r.status}`); continue; }
          html = await r.text();
        }
        // Strip tags, look for TC 846, TC 740, TC 470, TC 290, TC 971 etc.
        const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        const tcMatches = [...text.matchAll(/\b(150|290|470|766|846|740|971|976|977|960)\b\s+[^0-9]{0,40}(\d{2}-\d{2}-\d{4})\s*\$?([\d,.-]+)?/g)];
        const quarterMatch = text.match(/Tax Period Ending\s*([0-9-]+)|TAX PERIOD\s*:?\s*(2021[0-1][0-9])/i);
        const balance = text.match(/ACCOUNT BALANCE:?\s*\$?([\d,.-]+)/i);
        console.log(`    [${tail}]`);
        console.log(`      period:  ${quarterMatch?.[1] || quarterMatch?.[2] || 'unknown'}`);
        console.log(`      balance: ${balance?.[1] || '—'}`);
        for (const m of tcMatches.slice(0, 12)) {
          console.log(`      TC ${m[1]} · ${m[2]} · $${m[3] || '—'}`);
        }
      } catch (err) {
        console.log(`    [${tail}] fetch error: ${err.message}`);
      }
    }
  }
}

if (!byName?.length) {
  // Fallback — search via client name "TaxTaker"
  const { data: cli } = await sb.from('clients').select('id, name').ilike('name', '%taxtaker%');
  console.log(`\nFallback: clients matching "%taxtaker%": ${cli?.length || 0}`);
  for (const c of (cli || [])) console.log(`  · ${c.name} (id=${c.id})`);
}
