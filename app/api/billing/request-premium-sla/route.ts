/**
 * POST /api/billing/request-premium-sla
 *
 * Processor / manager-facing CTA: trial accounts (and any standard-tier
 * account) request to upgrade their client to the Premium SLA tier.
 *
 * Behavior:
 *   - Records the intent on clients (sets sla_tier_requested_at)
 *   - Emails matt@moderntax.io with the request + portal link to flip the
 *     tier from /admin/clients
 *   - Returns a friendly confirmation so the UI can show "request received,
 *     you'll hear from us within 24h"
 *
 * Why not auto-flip: Premium SLA is a commitment we make on turnaround +
 * expert routing. Matt wants eyes on every upgrade to set expectations +
 * confirm capacity before flipping. Trial accounts are the primary target;
 * we want a human in the loop so we can also pitch the annual contract
 * vs. month-to-month on the way through.
 *
 * Auth: any authenticated user. RLS-equivalent check: the caller must be
 * an active processor/manager/admin on a real client_id.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import sgMail from '@sendgrid/mail';
import { createServerRouteClient } from '@/lib/supabase-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_request: NextRequest) {
  const cookieStore = await cookies();
  const sb = createServerRouteClient(cookieStore);
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { data: profile } = await sb.from('profiles')
    .select('role, full_name, email, client_id, clients(name, sla_tier)')
    .eq('id', user.id).single() as { data: any };
  if (!profile || !profile.client_id) {
    return NextResponse.json({ error: 'No client associated' }, { status: 400 });
  }
  if (!['processor', 'manager', 'admin'].includes(profile.role || '')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (profile.clients?.sla_tier === 'premium') {
    return NextResponse.json({
      already_premium: true,
      message: 'Your account is already on Premium SLA.',
    });
  }

  // (2026-05-29) Removed the clients.sla_tier_requested_at stamp + the
  // admin client that powered it. That column was never created in
  // migration-sla-tier.sql, so we have no DB persistence layer for the
  // request. The Matt-notification email is the durable record; the
  // PremiumSlaSurface component tracks the "user clicked" state in
  // memory for the current session.

  // Notify Matt. Fire-and-forget — failure logged but doesn't block the
  // response (the row is stamped regardless).
  if (process.env.SENDGRID_API_KEY) {
    try {
      sgMail.setApiKey(process.env.SENDGRID_API_KEY);
      const requesterName = profile.full_name || profile.email;
      const clientName = profile.clients?.name || 'Unknown client';
      await sgMail.send({
        to: 'matt@moderntax.io',
        from: { email: 'no-reply@moderntax.io', name: 'ModernTax Portal' },
        subject: `Premium SLA upgrade requested — ${clientName}`,
        html: `
<div style="font-family:-apple-system,sans-serif;max-width:600px;line-height:1.5;color:#1a2845;">
  <p>Hi Matt,</p>
  <p><strong>${requesterName}</strong> (${profile.role} at <strong>${clientName}</strong>) requested an upgrade to <strong>Premium SLA</strong>.</p>
  <p>Premium SLA includes:</p>
  <ul>
    <li>Same-day turnaround target (vs. 24-48h standard)</li>
    <li>Expert-routing priority on the assignment queue</li>
    <li>Premium SLA badge across customer surfaces</li>
  </ul>
  <p>To flip the tier: <a href="https://portal.moderntax.io/admin/clients">admin/clients</a> → set <code>sla_tier='premium'</code>, or run an UPDATE in Studio.</p>
  <p>— ModernTax Portal</p>
</div>`,
        text: `${requesterName} (${profile.role} at ${clientName}) requested an upgrade to Premium SLA.\n\nTo flip: portal.moderntax.io/admin/clients\n\n— ModernTax Portal`,
      });
    } catch (err: any) {
      console.warn('[request-premium-sla] email failed:', err?.message || err);
    }
  }

  return NextResponse.json({
    success: true,
    message: 'Got it — we\'ll review your Premium SLA upgrade and confirm within 24h.',
  });
}
