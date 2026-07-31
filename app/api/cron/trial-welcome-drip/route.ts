/**
 * Trial Welcome Drip — daily cron
 *
 * Follow-up reminders to trial processors/managers who signed up but haven't
 * placed their first order. Signup now fires the transactional welcome email
 * (sendSignupApprovedEmail) as touch #1, so this drip owns the reminders after
 * it — starting ~2 days post-signup, then every 48h. Targets profiles that:
 *   • are processor OR manager on a client with free_trial = true
 *   • have NOT submitted any requests yet (first-request = conversion)
 *   • are not paused/unsubscribed, account < 30 days old, < 8 sends
 *
 * SHADOW by default behind TRIAL_DRIP_AUTOSEND (mirrors the other engines);
 * until that env is set it reports "would send" and sends nothing.
 *
 * Auth: CRON_SECRET via Authorization: Bearer header. Vercel cron: daily 14:00
 * UTC. The 48h "last sent" window makes it safe to run twice in a day.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { sendTrialWelcomeEmail } from '@/lib/sendgrid';
import { signUnsubscribeToken } from '@/lib/unsubscribe-tokens';
import { requireBearer } from '@/lib/auth-util';

export async function POST(request: NextRequest) {
  return handler(request);
}
export async function GET(request: NextRequest) {
  return handler(request);
}

async function handler(request: NextRequest) {
  try {
    const unauthorized = requireBearer(request, process.env.CRON_SECRET);
    if (unauthorized) return unauthorized;

    // SHADOW by default (consistent with the other lifecycle engines). Until
    // TRIAL_DRIP_AUTOSEND=true, this computes eligibility + logs "would send"
    // and sends nothing.
    const autoSend = process.env.TRIAL_DRIP_AUTOSEND === 'true';

    const admin = createAdminClient();
    const now = Date.now();
    const FORTY_EIGHT_HOURS_AGO = new Date(now - 48 * 60 * 60 * 1000).toISOString();
    const TWO_DAYS_AGO          = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    const THIRTY_DAYS_AGO       = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

    // 1. Find trial processors/managers created within the last 30 days. (Was
    //    manager-only, which missed self-serve signups — they're processors.)
    const { data: trialUsers } = await admin
      .from('profiles')
      .select('id, email, full_name, role, client_id, created_at, nudges_paused, clients(name, free_trial)')
      .in('role', ['processor', 'manager'])
      .gte('created_at', THIRTY_DAYS_AGO) as { data: any[] | null; error: any };

    const eligible = (trialUsers || []).filter(p => p.email && !p.nudges_paused && p.clients?.free_trial === true);

    // 2. Batch-fetch recent audit_log entries for all candidate profile IDs
    //    so we can answer "last sent" and "has unsubscribed" in-memory.
    const candidateIds = eligible.map(p => p.id);
    const { data: dripHistory } = candidateIds.length > 0
      ? await admin
          .from('audit_log')
          .select('entity_id, details, created_at')
          .in('entity_id', candidateIds)
          .eq('entity_type', 'profile')
          .eq('action', 'settings_changed')
          .gte('created_at', new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString()) as { data: any[] | null; error: any }
      : { data: [] as any[] };

    // Build per-profile state from audit rows.
    type DripState = { lastSentAt: string | null; sendCount: number; unsubscribedAt: string | null };
    const state = new Map<string, DripState>();
    for (const p of eligible) state.set(p.id, { lastSentAt: null, sendCount: 0, unsubscribedAt: null });

    for (const row of (dripHistory || [])) {
      const s = state.get(row.entity_id);
      if (!s) continue;
      const action: string | undefined = row.details?.action;
      if (action === 'trial_welcome_sent') {
        if (!s.lastSentAt || row.created_at > s.lastSentAt) s.lastSentAt = row.created_at;
        s.sendCount += 1;
      } else if (action === 'trial_welcome_unsubscribed') {
        if (!s.unsubscribedAt || row.created_at > s.unsubscribedAt) s.unsubscribedAt = row.created_at;
      }
    }

    // 3. Batch-check whether each profile has submitted any requests (= converted).
    const { data: requestCounts } = candidateIds.length > 0
      ? await admin
          .from('requests')
          .select('requested_by')
          .in('requested_by', candidateIds) as { data: any[] | null; error: any }
      : { data: [] as any[] };
    const converted = new Set((requestCounts || []).map(r => r.requested_by));

    // 4. Decide who gets an email this run.
    const sendsThisRun: Array<{ profile: any; sendNumber: number }> = [];
    for (const p of eligible) {
      const s = state.get(p.id)!;
      if (s.unsubscribedAt)                     continue; // opted out
      if (converted.has(p.id))                  continue; // already activated
      if (s.sendCount >= 8)                     continue; // hard cap — 30 days × 48h ≈ 15 sends max, 8 is humane
      if (!s.lastSentAt) {
        // No prior drip send. Signup now fires the transactional welcome email
        // (sendSignupApprovedEmail), so the drip owns the FOLLOW-UP reminders —
        // start once the welcome has had ~2 days to land, then every 48h.
        if (p.created_at > TWO_DAYS_AGO) continue;
      } else if (s.lastSentAt > FORTY_EIGHT_HOURS_AGO) {
        continue; // inside the 48h cooldown
      }
      sendsThisRun.push({ profile: p, sendNumber: s.sendCount + 1 });
    }

    // 5. Fire emails + record audit rows (unless shadow — then just report).
    const results: Array<{ email: string; sendNumber: number; status: 'sent' | 'failed' | 'shadow'; error?: string }> = [];
    for (const { profile, sendNumber } of sendsThisRun) {
      const firstName = (profile.full_name || '').trim().split(/\s+/)[0] || 'there';
      const clientName = profile.clients?.name || 'your team';
      if (!autoSend) {
        results.push({ email: profile.email, sendNumber, status: 'shadow' });
        continue;
      }
      try {
        await sendTrialWelcomeEmail({
          toEmail: profile.email,
          firstName,
          clientName,
          unsubscribeToken: signUnsubscribeToken(profile.id, 'trial_welcome'),
          sendNumber,
        });
        await admin.from('audit_log' as any).insert({
          user_email: profile.email,
          action: 'settings_changed',
          entity_type: 'profile',
          entity_id: profile.id,
          details: {
            action: 'trial_welcome_sent',
            send_number: sendNumber,
            client_id: profile.client_id,
            client_name: clientName,
            trigger: 'cron',
          },
        });
        results.push({ email: profile.email, sendNumber, status: 'sent' });
      } catch (err) {
        results.push({
          email: profile.email,
          sendNumber,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return NextResponse.json({
      success: true,
      mode: autoSend ? 'live' : 'shadow',
      considered: eligible.length,
      would_send: results.filter(r => r.status === 'shadow').length,
      sent: results.filter(r => r.status === 'sent').length,
      failed: results.filter(r => r.status === 'failed').length,
      skipped_reasons: {
        unsubscribed: eligible.filter(p => state.get(p.id)?.unsubscribedAt).length,
        converted:    eligible.filter(p => converted.has(p.id)).length,
        in_cooldown:  eligible.filter(p => {
          const s = state.get(p.id);
          return s && s.lastSentAt && s.lastSentAt > FORTY_EIGHT_HOURS_AGO;
        }).length,
        no_prior_send: eligible.filter(p => !state.get(p.id)?.lastSentAt).length,
      },
      results,
    });
  } catch (error) {
    console.error('trial-welcome-drip error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
