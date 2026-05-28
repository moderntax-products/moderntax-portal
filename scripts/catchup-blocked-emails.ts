/**
 * Catch-up sends for emails blocked during the SendGrid quota window
 * (April 30 evening — May 1 mid-day, until plan upgrade).
 *
 * Three categories per Matt 2026-05-01:
 *   1. Completed transcript notifications to processors (consolidated per
 *      processor as a 48-hour digest, so we don't double-send if some
 *      individual notifications partially succeeded earlier).
 *   2. Admin daily summaries that didn't fire (April 30 specifically;
 *      May 1's already ran post-restoration).
 *   3. New expert assignment notifications (consolidated per expert).
 *
 * Run: npx tsx scripts/catchup-blocked-emails.ts <target> [--dry-run]
 *   targets: completions | assignments | daily-summary | all
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import sgMail from '@sendgrid/mail';
import { createClient } from '@supabase/supabase-js';

sgMail.setApiKey(process.env.SENDGRID_API_KEY!);
const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'notifications@moderntax.io';
const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io';
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const target = process.argv[2] || '';
const dryRun = process.argv.includes('--dry-run');

if (!['completions', 'assignments', 'daily-summary', 'all'].includes(target)) {
  console.error('Usage: npx tsx scripts/catchup-blocked-emails.ts <completions|assignments|daily-summary|all> [--dry-run]');
  process.exit(1);
}

// Window: cover the full SendGrid outage. Quota error first appeared in logs
// around 2026-05-01 19:25 UTC; Matt confirmed it had been failing yesterday
// too. Use a 48-hour lookback to be safe.
const lookbackMs = 48 * 60 * 60 * 1000;
const since = new Date(Date.now() - lookbackMs).toISOString();
const sinceLabel = new Date(since).toLocaleString('en-US', {
  timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short',
});

// ---------------------------------------------------------------------------
// Email shell — minimal HTML wrapper, matches the production createEmailTemplate
// look-and-feel without importing lib/sendgrid (which captures env at module load
// and breaks when run via tsx if dotenv loads after).
// ---------------------------------------------------------------------------

function emailShell(title: string, content: string, cta?: { text: string; url: string }): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.6;color:#333;max-width:600px;margin:0 auto;padding:24px;background:#f5f5f5;">
<div style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
<div style="background:linear-gradient(135deg,#0A1929 0%,#102A43 100%);color:#fff;padding:32px 24px;border-bottom:4px solid #00C48C;text-align:center;">
<div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;opacity:0.8;margin-bottom:10px;">ModernTax</div>
<h1 style="margin:0;font-size:22px;font-weight:600;">${title}</h1>
</div>
<div style="padding:32px 28px;">
<div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:12px 16px;margin-bottom:24px;border-radius:4px;font-size:13px;color:#78350f;">
<strong>Catch-up notice:</strong> Our email provider was over its monthly quota since ${sinceLabel} PT. We've upgraded the plan and are pushing out the notifications you should have received during that window. Sorry for the lag.
</div>
${content}
${cta ? `<p style="text-align:center;margin:32px 0 0;"><a href="${cta.url}" style="display:inline-block;background:#00C48C;color:#fff;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;">${cta.text}</a></p>` : ''}
</div>
</div>
</body></html>`;
}

const fmtPct = (n: number | null | undefined) => (n == null ? 'N/A' : `${n}%`);

// ---------------------------------------------------------------------------
// 1. Per-processor completion digest
// ---------------------------------------------------------------------------

async function sendCompletionDigests() {
  // All entities completed in the lookback window, joined to request + processor profile
  const { data: rows, error } = await supabase
    .from('request_entities')
    .select('id, entity_name, form_type, compliance_score, completed_at, ' +
      'requests!inner ( id, loan_number, requested_by, client_id, ' +
      'profiles:requested_by ( id, email, full_name ), ' +
      'clients ( name, slug ) )')
    .eq('status', 'completed')
    .gte('completed_at', since)
    .order('completed_at', { ascending: true }) as { data: any[] | null; error: any };

  if (error) { console.error('Completions query failed:', error.message); return; }
  if (!rows || rows.length === 0) {
    console.log('[completions] No entities completed in last 48h');
    return;
  }

  // Group by processor (requests.profiles.id)
  const byProcessor = new Map<string, {
    email: string; name: string;
    entries: { entityName: string; formType: string; loanNumber: string;
               clientName: string; completedAt: string; complianceScore: number | null;
               requestId: string }[];
  }>();
  for (const e of rows) {
    const p = e.requests.profiles;
    if (!p?.email) continue;
    const key = p.id;
    let g = byProcessor.get(key);
    if (!g) { g = { email: p.email, name: p.full_name || p.email, entries: [] }; byProcessor.set(key, g); }
    g.entries.push({
      entityName: e.entity_name || '(unnamed)',
      formType: e.form_type || '-',
      loanNumber: e.requests.loan_number || '-',
      clientName: e.requests.clients?.name || '-',
      completedAt: e.completed_at,
      complianceScore: e.compliance_score,
      requestId: e.requests.id,
    });
  }

  console.log(`[completions] ${byProcessor.size} processors, ${rows.length} entities to digest`);

  for (const [, g] of byProcessor) {
    const list = g.entries.map(e => {
      const dt = new Date(e.completedAt).toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short',
      });
      return `<li><strong>${e.entityName}</strong> (${e.formType}) - Loan ${e.loanNumber} - completed ${dt} - Compliance: ${fmtPct(e.complianceScore)} - <a href="${appUrl}/requests/${e.requestId}">view</a></li>`;
    }).join('');

    const content = `
<p>Hi ${g.name.split(' ')[0]},</p>
<p>Below is a recap of the IRS transcripts your team completed in the last 48 hours. You can click through any entity to download the transcripts and review compliance scores.</p>
<p><strong>${g.entries.length} ${g.entries.length === 1 ? 'entity' : 'entities'} completed:</strong></p>
<ul style="line-height:1.8;">${list}</ul>
<p style="font-size:13px;color:#666;">If anything looks off or missing, reply to this email and we'll dig in.</p>`;

    const html = emailShell('Transcripts Completed - 48h Recap', content, {
      text: 'View All Requests', url: `${appUrl}/requests`,
    });

    if (dryRun) {
      console.log(`[dry-run] would send to ${g.email} - ${g.entries.length} entities`);
      continue;
    }
    try {
      await sgMail.send({
        to: g.email, from: fromEmail,
        subject: `${g.entries.length} transcript${g.entries.length === 1 ? '' : 's'} completed - 48h recap`,
        html, replyTo: 'support@moderntax.io',
      });
      console.log(`[completions] sent to ${g.email} - ${g.entries.length} entities`);
    } catch (err) {
      console.error(`[completions] failed for ${g.email}:`, (err as Error).message);
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Per-expert new assignment digest
// ---------------------------------------------------------------------------

async function sendAssignmentDigests() {
  const { data: rows, error } = await supabase
    .from('expert_assignments')
    .select('id, assigned_at, status, ' +
      'expert:expert_id ( id, email, full_name ), ' +
      'request_entities ( entity_name, form_type, requests ( loan_number, clients ( name ) ) )')
    .gte('assigned_at', since)
    .order('assigned_at', { ascending: true }) as { data: any[] | null; error: any };

  if (error) { console.error('Assignments query failed:', error.message); return; }
  if (!rows || rows.length === 0) {
    console.log('[assignments] No new expert assignments in last 48h');
    return;
  }

  const byExpert = new Map<string, {
    email: string; name: string;
    entries: { entityName: string; formType: string; loanNumber: string;
               clientName: string; status: string; assignedAt: string }[];
  }>();
  for (const a of rows) {
    const e = a.expert;
    if (!e?.email) continue;
    const key = e.id;
    let g = byExpert.get(key);
    if (!g) { g = { email: e.email, name: e.full_name || e.email, entries: [] }; byExpert.set(key, g); }
    g.entries.push({
      entityName: a.request_entities?.entity_name || '(entity)',
      formType: a.request_entities?.form_type || '-',
      loanNumber: a.request_entities?.requests?.loan_number || '-',
      clientName: a.request_entities?.requests?.clients?.name || '-',
      status: a.status || 'assigned',
      assignedAt: a.assigned_at,
    });
  }

  console.log(`[assignments] ${byExpert.size} experts, ${rows.length} assignments to digest`);

  for (const [, g] of byExpert) {
    const list = g.entries.map(e => {
      const dt = new Date(e.assignedAt).toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short',
      });
      return `<li><strong>${e.entityName}</strong> (${e.formType}) - ${e.clientName} - Loan ${e.loanNumber} - assigned ${dt} - status: <em>${e.status}</em></li>`;
    }).join('');

    const content = `
<p>Hi ${g.name.split(' ')[0]},</p>
<p>You were assigned <strong>${g.entries.length}</strong> new ${g.entries.length === 1 ? 'entity' : 'entities'} in the last 48 hours. Each one needs an IRS transcript pull. SLA clock starts at assignment time (business hours, Mon-Fri 7am-7pm local).</p>
<p><strong>Your new assignments:</strong></p>
<ul style="line-height:1.8;">${list}</ul>
<p style="font-size:13px;color:#666;">Log in to your Expert Queue to download signed 8821 forms and start pulling transcripts. Use the Flag Issue feature if anything's blocking you.</p>`;

    const html = emailShell('New Assignments - 48h Recap', content, {
      text: 'Open Expert Queue', url: `${appUrl}/expert`,
    });

    if (dryRun) {
      console.log(`[dry-run] would send to ${g.email} - ${g.entries.length} assignments`);
      continue;
    }
    try {
      await sgMail.send({
        to: g.email, from: fromEmail,
        subject: `${g.entries.length} new assignment${g.entries.length === 1 ? '' : 's'} - 48h recap`,
        html, replyTo: 'support@moderntax.io',
      });
      console.log(`[assignments] sent to ${g.email} - ${g.entries.length} assignments`);
    } catch (err) {
      console.error(`[assignments] failed for ${g.email}:`, (err as Error).message);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Backfill April 30 admin daily summary
// ---------------------------------------------------------------------------

async function sendAprilThirtyDailySummary() {
  // Same shape as the cron, but date-bounded to Apr 30 instead of "today".
  const dayStart = new Date('2026-04-30T07:00:00.000Z'); // 12am PT
  const dayEnd = new Date('2026-05-01T07:00:00.000Z');
  const dayStartIso = dayStart.toISOString();
  const dayEndIso = dayEnd.toISOString();
  const dateLabel = 'Wednesday, April 30, 2026';

  // New entities on Apr 30
  const { data: newReqs } = await supabase
    .from('requests')
    .select('id, request_entities(id)')
    .gte('created_at', dayStartIso)
    .lt('created_at', dayEndIso) as { data: any[] | null };
  const newEntities = (newReqs || []).reduce((s, r) => s + (r.request_entities?.length || 0), 0);

  // Completions on Apr 30
  const { data: completions } = await supabase
    .from('request_entities')
    .select('id, completed_at')
    .eq('status', 'completed')
    .gte('completed_at', dayStartIso)
    .lt('completed_at', dayEndIso) as { data: any[] | null };
  const completed = completions?.length || 0;

  // Failures on Apr 30
  const { data: failures } = await supabase
    .from('request_entities')
    .select('id')
    .eq('status', 'failed')
    .gte('updated_at', dayStartIso)
    .lt('updated_at', dayEndIso) as { data: any[] | null };
  const failed = failures?.length || 0;

  // Active experts (assignments updated on Apr 30)
  const { data: activeAss } = await supabase
    .from('expert_assignments')
    .select('expert_id')
    .gte('updated_at', dayStartIso)
    .lt('updated_at', dayEndIso) as { data: any[] | null };
  const activeExperts = new Set((activeAss || []).map(a => a.expert_id)).size;

  // Find admins
  const { data: admins } = await supabase
    .from('profiles')
    .select('email, full_name')
    .eq('role', 'admin')
    .not('email', 'is', null) as { data: { email: string; full_name: string | null }[] | null };
  if (!admins || admins.length === 0) { console.log('[daily-summary] no admins'); return; }

  const content = `
<p>Daily operations digest for <strong>${dateLabel}</strong>. This summary didn't fire on schedule because our email provider hit its quota that evening — pushing it out now for the record.</p>
<table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:14px;">
<tr><td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;"><strong>New entities submitted</strong></td><td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;text-align:right;">${newEntities}</td></tr>
<tr><td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;"><strong>Entities completed</strong></td><td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;text-align:right;color:#15803d;"><strong>${completed}</strong></td></tr>
<tr><td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;"><strong>Failures</strong></td><td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;text-align:right;color:#dc2626;">${failed}</td></tr>
<tr><td style="padding:10px 14px;"><strong>Active experts</strong></td><td style="padding:10px 14px;text-align:right;">${activeExperts}</td></tr>
</table>
<p style="font-size:13px;color:#666;">Today (May 1) ran the daily summary cron post-restoration; this fills in the Apr 30 gap.</p>`;

  for (const a of admins) {
    if (dryRun) { console.log(`[dry-run] daily-summary → ${a.email} (${dateLabel})`); continue; }
    try {
      await sgMail.send({
        to: a.email, from: fromEmail,
        subject: `[Backfill] Daily Operations Summary - ${dateLabel}`,
        html: emailShell(`Daily Summary - ${dateLabel}`, content, { text: 'View Admin Dashboard', url: `${appUrl}/admin` }),
        replyTo: 'support@moderntax.io',
      });
      console.log(`[daily-summary] sent → ${a.email}`);
    } catch (err) {
      console.error(`[daily-summary] failed for ${a.email}:`, (err as Error).message);
    }
  }
}

async function main() {
  console.log(`Catch-up window: ${sinceLabel} PT → now (${lookbackMs / 3600000}h)`);
  if (target === 'completions' || target === 'all') await sendCompletionDigests();
  if (target === 'assignments' || target === 'all')  await sendAssignmentDigests();
  if (target === 'daily-summary' || target === 'all') await sendAprilThirtyDailySummary();
  console.log('Catch-up complete.');
}
main().catch(e => { console.error(e); process.exit(1); });
