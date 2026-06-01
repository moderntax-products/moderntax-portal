/**
 * GET /api/cron/hot-trial-alert
 * Every 4h. Finds trial clients that completed a pull in last 24h, not converted, not alerted.
 * Sends internal email to matt@moderntax.io.
 */
import { NextRequest, NextResponse } from 'next/server';
import sgMail from '@sendgrid/mail';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';
import { logFunnelEvent } from '@/lib/funnel-events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  const admin = createAdminClient();
  const oneDayAgo = new Date();
  oneDayAgo.setHours(oneDayAgo.getHours() - 24);

  let hotClients: any[] = [];
  try {
    const { data: recentPulls } = await (admin.from('trial_funnel_events') as any)
      .select('client_id').eq('event_type', 'pull_completed').gte('created_at', oneDayAgo.toISOString());
    if (!recentPulls?.length) return NextResponse.json({ success: true, alerted: 0 });

    const clientIds = [...new Set((recentPulls as any[]).map((r: any) => r.client_id))];

    const { data: converted } = await (admin.from('trial_funnel_events') as any)
      .select('client_id').eq('event_type', 'trial_converted').in('client_id', clientIds);
    const convertedIds = new Set((converted || []).map((r: any) => r.client_id));

    const { data: alerted } = await (admin.from('trial_funnel_events') as any)
      .select('client_id').eq('event_type', 'hot_trial_alerted')
      .gte('created_at', oneDayAgo.toISOString()).in('client_id', clientIds);
    const alertedIds = new Set((alerted || []).map((r: any) => r.client_id));

    const hotIds = clientIds.filter(id => !convertedIds.has(id) && !alertedIds.has(id));
    if (!hotIds.length) return NextResponse.json({ success: true, alerted: 0 });

    const { data: clients } = await admin.from('clients').select('id, name').in('id', hotIds);
    hotClients = clients || [];
  } catch {
    return NextResponse.json({ success: true, alerted: 0, note: 'trial_funnel_events not yet migrated' });
  }

  if (!hotClients.length) return NextResponse.json({ success: true, alerted: 0 });

  if (process.env.SENDGRID_API_KEY) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    const list = hotClients.map((c: any) => `<li><strong>${c.name}</strong></li>`).join('');
    try {
      await sgMail.send({
        to: 'matt@moderntax.io',
        from: { email: 'no-reply@moderntax.io', name: 'ModernTax Portal' },
        subject: `Hot trial${hotClients.length > 1 ? 's' : ''}: ${hotClients.map((c: any) => c.name).join(', ')}`,
        html: `<div style="font-family:-apple-system,sans-serif;max-width:580px;color:#1a2845;"><p>Hey Matt,</p><p>These trial clients completed a pull in the last 24 hours and have not converted yet:</p><ul>${list}</ul><p><a href="https://portal.moderntax.io/admin/funnel" style="color:#00C48C;font-weight:600;">View hot trials dashboard →</a></p></div>`,
        text: `Hot trials: ${hotClients.map((c: any) => c.name).join(', ')}. View: https://portal.moderntax.io/admin/funnel`,
      });
    } catch { /* non-fatal */ }
  }

  for (const client of hotClients) {
    await logFunnelEvent(admin, 'hot_trial_alerted', client.id, null, { client_name: client.name });
  }

  return NextResponse.json({ success: true, alerted: hotClients.length, clients: hotClients.map((c: any) => c.name) });
}
