/**
 * Investigate the IRS PPS call session cancelled Mon May 11 at 12:22 PM
 * with 3 entities: Great Lakes Wood Co LLC, Mento Technologies Inc,
 * OMT Addiction Centers LLC. 33-min duration, $2.98 cost.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  // Find irs_call_sessions cancelled today with these entities.
  // Look at the May 11 window
  const since = '2026-05-11T00:00:00Z';
  const { data: sessions } = await supabase
    .from('irs_call_sessions' as any)
    .select('*')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(20) as { data: any[] | null };

  console.log(`=== IRS call sessions created since ${since}: ${sessions?.length || 0} ===\n`);

  for (const s of sessions || []) {
    console.log(`---`);
    console.log(`Session ID:   ${s.id}`);
    console.log(`Expert:       ${s.expert_name || s.expert_id}`);
    console.log(`Status:       ${s.status}`);
    console.log(`Callback:     ${s.callback_status} (${s.callback_phone || '—'})`);
    console.log(`Call ID:      ${s.bland_call_id || '—'}`);
    console.log(`Scheduled:    ${s.scheduled_for || '—'}`);
    console.log(`Initiated:    ${s.initiated_at || '—'}`);
    console.log(`Agent ans:    ${s.agent_answered_at || '—'}`);
    console.log(`Ended:        ${s.ended_at || '—'}`);
    console.log(`Duration ms:  ${s.duration_ms || '—'}`);
    console.log(`Cost:         ${s.cost_per_minute ? `$${s.cost_per_minute}/min` : '—'}`);
    console.log(`From #:       ${s.from_number || '—'}`);
    console.log(`Error msg:    ${s.error_message || '—'}`);
    console.log(`Coaching:     ${s.coaching_notes || '—'}`);
    console.log(`Classified:   ${s.classified_outcome || '—'}`);
    console.log(`Retry chain:  parent=${s.parent_session_id || 'root'}  count=${s.retry_count}  terminal=${s.retry_terminal_state || '—'}`);
  }

  // Find the cancelled session with all 3 entities — look at entities joined
  console.log('\n\n=== Entities by session today ===');
  for (const s of sessions || []) {
    const { data: callEnts } = await supabase
      .from('irs_call_entities' as any)
      .select('id, entity_id, taxpayer_name, form_type, tax_years, status, request_entities(entity_name, request_id, requests(loan_number, clients(name)))')
      .eq('call_session_id', s.id) as { data: any[] | null };
    if (!callEnts || callEnts.length === 0) continue;
    console.log(`\nSession ${s.id} (status=${s.status}, duration=${Math.round((s.duration_ms || 0) / 1000)}s):`);
    for (const ce of callEnts) {
      const re = (ce as any).request_entities;
      console.log(`  • ${ce.taxpayer_name} (${ce.form_type}, ${JSON.stringify(ce.tax_years)})`);
      console.log(`    entity_id=${ce.entity_id}  client=${re?.requests?.clients?.name}  loan=${re?.requests?.loan_number}  ce.status=${ce.status}`);
    }
  }

  // Also pull audit log for any call_cancelled or status_changed today
  const { data: audit } = await supabase
    .from('audit_log' as any)
    .select('*')
    .gte('created_at', since)
    .ilike('action', '%call%')
    .order('created_at', { ascending: false })
    .limit(30);
  console.log(`\n\n=== Audit log call-related events today (${audit?.length || 0}) ===`);
  for (const a of audit || []) {
    console.log(`\n  ${a.created_at}  ${a.action}  by=${a.user_email}`);
    console.log(`    entity_id=${a.entity_id || '—'}`);
    console.log(`    details=${JSON.stringify(a.details || {}).slice(0, 280)}`);
  }

  // Look for any transcripts uploaded during this call window
  const { data: uploads } = await supabase
    .from('audit_log' as any)
    .select('*')
    .gte('created_at', since)
    .ilike('action', '%transcript%')
    .order('created_at', { ascending: false })
    .limit(20);
  console.log(`\n\n=== Transcript uploads today (${uploads?.length || 0}) ===`);
  for (const u of uploads || []) {
    console.log(`  ${u.created_at}  ${u.action}  entity=${u.entity_id}  details=${JSON.stringify(u.details).slice(0, 200)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
