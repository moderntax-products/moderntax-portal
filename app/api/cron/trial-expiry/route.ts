/**
 * GET /api/cron/trial-expiry
 * Daily at 08:00 UTC. Three passes:
 *   1. Auto-convert clients with card on file past trial_expires_at
 *   2. Expire clients past 48h grace with no card
 *   3. Send day-5 reminder emails
 */
import { NextRequest, NextResponse } from 'next/server';
import sgMail from '@sendgrid/mail';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';
import { logFunnelEvent } from '@/lib/funnel-events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  const admin = createAdminClient();
  const now = new Date();
  const log: string[] = [];
  const L = (s: string) => { log.push(s); console.log('[trial-expiry] ' + s); };

  // Pass 1: Auto-convert
  const { data: convertCandidates } = await (admin.from('clients') as any)
    .select('id, name')
    .not('trial_card_captured_at', 'is', null)
    .is('trial_converted_at', null)
    .eq('free_trial', true)
    .lte('trial_expires_at', now.toISOString());

  let converted = 0;
  for (const client of (convertCandidates || [])) {
    L(`Converting ${client.name}`);
    try {
      const base = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io';
      const res = await fetch(`${base}/api/billing/convert-trial`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.CRON_SECRET}` },
        body: JSON.stringify({ client_id: client.id }),
      });
      const data = await res.json();
      if (res.ok) { L(`✓ Converted ${client.name}`); converted++; }
      else { L(`✗ Failed ${client.name}: ${data.error}`); }
    } catch (err: any) { L(`✗ Exception ${client.name}: ${err?.message}`); }
  }

  // Pass 2: Expire (past 48h grace, no card)
  const graceEnd = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  const { data: expireCandidates } = await (admin.from('clients') as any)
    .select('id, name, billing_ap_email')
    .is('trial_card_captured_at', null)
    .is('trial_converted_at', null)
    .eq('free_trial', true)
    .not('trial_expires_at', 'is', null)
    .lte('trial_expires_at', graceEnd.toISOString());

  let expired = 0;
  for (const client of (expireCandidates || [])) {
    L(`Expiring ${client.name}`);
    await (admin.from('clients') as any).update({ trial_entities_allowed: 0 }).eq('id', client.id);
    await logFunnelEvent(admin, 'trial_expired', client.id, null, { expired_at: now.toISOString() });
    if (process.env.SENDGRID_API_KEY && client.billing_ap_email) {
      try {
        sgMail.setApiKey(process.env.SENDGRID_API_KEY);
        await sgMail.send({
          to: client.billing_ap_email,
          from: { email: 'no-reply@moderntax.io', name: 'ModernTax' },
          subject: 'Your ModernTax trial has ended — add a card to continue',
          html: `<div style="font-family:-apple-system,sans-serif;max-width:580px;color:#1a2845;"><p>Hi,</p><p>Your ModernTax trial ended and we did not have a card on file to continue.</p><p><a href="https://portal.moderntax.io/trial-activate" style="color:#00C48C;font-weight:600;">Add a card to resume</a> — $59.98/entity, charged only when reports deliver.</p><p>— Matt, ModernTax</p></div>`,
          text: `Your ModernTax trial ended. Add a card to resume: https://portal.moderntax.io/trial-activate`,
        });
      } catch (err: any) { L(`! email failed: ${err?.message}`); }
    }
    expired++;
  }

  // Pass 3: Day-5 reminders
  const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
  const fourDaysAgo = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000);
  const { data: reminderCandidates } = await (admin.from('clients') as any)
    .select('id, name, billing_ap_email')
    .not('trial_card_captured_at', 'is', null)
    .is('trial_converted_at', null)
    .eq('free_trial', true)
    .gte('trial_card_captured_at', fourDaysAgo.toISOString())
    .lte('trial_card_captured_at', fiveDaysAgo.toISOString());

  let reminded = 0;
  for (const client of (reminderCandidates || [])) {
    const { data: existing } = await (admin.from('trial_funnel_events') as any)
      .select('id').eq('client_id', client.id).eq('event_type', 'reminder_sent').maybeSingle();
    if (existing) continue;
    if (process.env.SENDGRID_API_KEY && client.billing_ap_email) {
      try {
        sgMail.setApiKey(process.env.SENDGRID_API_KEY);
        await sgMail.send({
          to: client.billing_ap_email,
          from: { email: 'no-reply@moderntax.io', name: 'ModernTax' },
          subject: '2 days left on your ModernTax trial',
          html: `<div style="font-family:-apple-system,sans-serif;max-width:580px;color:#1a2845;"><p>Hi,</p><p>Quick note — your ModernTax trial expires in 2 days. After your trial pull completes, we charge $59.98 to your card on file. No action needed.</p><p><a href="https://portal.moderntax.io/new" style="color:#00C48C;font-weight:600;">Submit another request →</a></p><p>— Matt</p></div>`,
          text: `Your ModernTax trial expires in 2 days. After your trial pull completes, we charge $59.98/entity to the card on file.`,
        });
        await logFunnelEvent(admin, 'reminder_sent', client.id, null, { day: 5 });
        reminded++;
      } catch (err: any) { L(`! reminder failed: ${err?.message}`); }
    }
  }

  L(`Done — converted: ${converted}, expired: ${expired}, reminded: ${reminded}`);
  return NextResponse.json({ success: true, converted, expired, reminded, log });
}
