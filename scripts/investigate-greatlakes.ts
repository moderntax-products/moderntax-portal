/**
 * One-off: investigate the Centerstone mix-up between
 * Great Lakes Wood Co LLC and Peter Geyen Inc.
 *
 * Soobin (Centerstone credit analyst) reported:
 *   1. Asked for 2025 BTR transcripts for Great Lakes Wood Co LLC.
 *      The portal shows 2025 transcripts pulled for Peter Geyen Inc.
 *      instead. Wants 2022 + 2025 for Great Lakes Wood only.
 *   2. Monitoring was enabled on one entity without Soobin enrolling.
 *      Soobin already cancelled it.
 *
 * Goal: surface
 *   - Both entities' DB rows, their tids/EINs, transcript URLs
 *   - The request(s) that produced these pulls and who submitted them
 *   - The monitoring enrollment audit trail (who enabled, when)
 *   - Any relationship between the two entities (same request? sibling?)
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  // ----- 1. Locate both entities -----
  const { data: ents, error: entErr } = await supabase
    .from('request_entities')
    .select('id, entity_name, tid, tid_kind, form_type, years, status, request_id, transcript_urls, transcript_html_urls, gross_receipts, signed_8821_url, signature_created_at, created_at, updated_at, completed_at')
    .or('entity_name.ilike.%Great Lakes Wood%,entity_name.ilike.%Peter Geyen%');

  if (entErr) {
    console.error('entity lookup failed:', entErr);
    return;
  }

  console.log(`\n=== Entities matched (${ents?.length || 0}) ===`);
  for (const e of ents || []) {
    console.log('\n----------------------------------');
    console.log(`Name:        ${e.entity_name}`);
    console.log(`ID:          ${e.id}`);
    console.log(`TID:         ${e.tid} (${e.tid_kind})`);
    console.log(`Form:        ${e.form_type}`);
    console.log(`Years:       ${JSON.stringify(e.years)}`);
    console.log(`Status:      ${e.status}`);
    console.log(`Request ID:  ${e.request_id}`);
    console.log(`Created:     ${e.created_at}`);
    console.log(`Updated:     ${e.updated_at}`);
    console.log(`Completed:   ${e.completed_at || '—'}`);
    console.log(`Signed8821:  ${e.signed_8821_url ? 'YES' : 'NO'} ${e.signature_created_at ? `(${e.signature_created_at})` : ''}`);
    console.log(`Transcripts (PDF):   ${(e.transcript_urls || []).length} files`);
    (e.transcript_urls || []).slice(0, 8).forEach((u: string) => console.log(`  - ${u}`));
    console.log(`Transcripts (HTML):  ${(e.transcript_html_urls || []).length} files`);
    (e.transcript_html_urls || []).slice(0, 8).forEach((u: string) => console.log(`  - ${u}`));
  }

  // ----- 2. Pull the requests these entities live under -----
  const requestIds = Array.from(new Set((ents || []).map((e: any) => e.request_id)));
  if (requestIds.length === 0) {
    console.log('\nNo requests to dig into.');
    return;
  }
  const { data: reqs } = await supabase
    .from('requests')
    .select('id, loan_number, client_id, requested_by, intake_method, status, created_at, completed_at, clients(name), profiles!requests_requested_by_fkey(full_name, email)')
    .in('id', requestIds);

  console.log(`\n\n=== Requests (${reqs?.length || 0}) ===`);
  for (const r of reqs || []) {
    console.log('\n----------------------------------');
    console.log(`Loan:        ${r.loan_number}`);
    console.log(`Request ID:  ${r.id}`);
    console.log(`Client:      ${(r as any).clients?.name}`);
    console.log(`Submitted by: ${(r as any).profiles?.full_name} <${(r as any).profiles?.email}>`);
    console.log(`Intake:      ${r.intake_method}`);
    console.log(`Status:      ${r.status}`);
    console.log(`Created:     ${r.created_at}`);
    console.log(`Completed:   ${r.completed_at || '—'}`);
  }

  // ----- 3. List ALL entities under each of those requests so we can see -----
  //         if the two are in the same loan / accidentally bundled.
  const { data: sibEnts } = await supabase
    .from('request_entities')
    .select('id, entity_name, tid, form_type, years, status, request_id, transcript_urls, completed_at')
    .in('request_id', requestIds);

  const byRequest: Record<string, any[]> = {};
  for (const e of sibEnts || []) {
    (byRequest[e.request_id] ||= []).push(e);
  }
  console.log(`\n\n=== All entities under these requests ===`);
  for (const [rid, list] of Object.entries(byRequest)) {
    console.log(`\nRequest ${rid}:`);
    for (const e of list) {
      console.log(`  - ${e.entity_name} (tid=${e.tid}, form=${e.form_type}, years=${JSON.stringify(e.years)}, status=${e.status}, transcripts=${(e.transcript_urls || []).length})`);
    }
  }

  // ----- 4. Monitoring enrollment trail -----
  const entityIds = (ents || []).map((e: any) => e.id);
  const { data: monitoring } = await supabase
    .from('entity_monitoring' as any)
    .select('*')
    .in('entity_id', entityIds);

  console.log(`\n\n=== Monitoring records for these entities (${monitoring?.length || 0}) ===`);
  for (const m of monitoring || []) {
    console.log(`\n  entity_id:     ${m.entity_id}`);
    console.log(`  status:        ${m.status}`);
    console.log(`  frequency:     ${m.frequency || m.cadence}`);
    console.log(`  enrolled_at:   ${m.enrolled_at || m.created_at}`);
    console.log(`  enrolled_by:   ${m.enrolled_by || '—'}`);
    console.log(`  cancelled_at:  ${m.cancelled_at || m.deactivated_at || '—'}`);
    console.log(`  next_pull_at:  ${m.next_pull_at || '—'}`);
    console.log(`  notes:         ${m.notes || '—'}`);
  }

  // ----- 5. Audit log around these entities -----
  const { data: audit } = await supabase
    .from('audit_log' as any)
    .select('*')
    .in('entity_id', entityIds)
    .order('created_at', { ascending: false })
    .limit(40);

  console.log(`\n\n=== Audit log entries (${audit?.length || 0}) — most recent first ===`);
  for (const a of audit || []) {
    console.log(`\n  ${a.created_at}  ${a.action}`);
    console.log(`    by:        ${a.user_email || '—'}`);
    console.log(`    entity_id: ${a.entity_id}`);
    console.log(`    details:   ${JSON.stringify(a.details || {}).slice(0, 200)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
