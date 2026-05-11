/**
 * Sanity-test the ERC parser against Mento's actual 941 transcripts.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { buildERCReport, ercStatusLabel } from '@/lib/erc-analysis';

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { data: e } = await supabase
    .from('request_entities')
    .select('id, entity_name, tid, transcript_urls, transcript_html_urls')
    .eq('id', 'f92264b1-d420-4865-93f0-33943fc507ff')
    .single() as { data: any };

  const allUrls: string[] = Array.from(new Set([
    ...(e.transcript_urls || []),
    ...(e.transcript_html_urls || []),
  ])).filter(u => u.endsWith('.html'));

  const transcripts: { source: string; html: string }[] = [];
  for (const url of allUrls) {
    const { data: file } = await supabase.storage.from('uploads').download(url);
    if (!file) continue;
    const html = Buffer.from(await file.arrayBuffer()).toString('utf8');
    transcripts.push({ source: url, html });
  }
  console.log(`Loaded ${transcripts.length} transcripts for ${e.entity_name}\n`);

  const report = buildERCReport(e.entity_name, e.tid, transcripts);

  console.log(`=== SUMMARY ===`);
  console.log(`Total recoverable:           $${report.summary.totalRecoverable.toFixed(2)}`);
  console.log(`Quarters paid:               ${report.summary.quartersPaid}`);
  console.log(`Quarters undelivered:        ${report.summary.quartersUndelivered}`);
  console.log(`Quarters pending:            ${report.summary.quartersPending}`);
  console.log(`Quarters denied:             ${report.summary.quartersDenied}`);
  console.log(`Quarters no claim:           ${report.summary.quartersNoClaim}`);
  console.log(`Quarters missing transcript: ${report.summary.quartersMissingTranscript}`);
  console.log(`Action items:                ${report.summary.actionRequiredCount}`);
  console.log(`Missing quarters: ${report.missingQuarters.map(q => `${q.year}-Q${q.quarter}`).join(', ')}\n`);

  for (const q of report.quarters) {
    console.log(`--- ${q.year} Q${q.quarter} (period ending ${q.taxPeriodEnding}) ---`);
    console.log(`  Status:         ${ercStatusLabel(q.status)}`);
    console.log(`  Deadline:       ${q.filingDeadline} (${q.deadlinePassed ? 'PASSED' : 'open'})`);
    if (q.ercCreditAmount !== null) console.log(`  ERC credit (TC 766):       $${Math.abs(q.ercCreditAmount).toFixed(2)}`);
    if (q.refundIssuedAmount !== null) console.log(`  Refund issued (TC 846):   $${q.refundIssuedAmount.toFixed(2)} on ${q.refundIssuedDate}`);
    if (q.refundReturnedDate) console.log(`  Refund returned (TC 740): ${q.refundReturnedDate}`);
    if (q.currentAccountBalance !== null) console.log(`  Current balance:           $${q.currentAccountBalance.toFixed(2)}`);
    console.log(`  Total recoverable:         $${q.totalRecoverable.toFixed(2)}`);
    if (q.actionRequired) console.log(`  → Action: ${q.actionRequired}`);
    q.notes.forEach(n => console.log(`    note: ${n}`));
    if (q.eligibilityNote) console.log(`  ⚠ ${q.eligibilityNote}`);
    console.log('');
  }
}
main().catch(e => { console.error(e); process.exit(1); });
