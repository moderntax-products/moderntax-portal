/**
 * Same-day per-order invoicing cron (#3, 2026-06-28).
 *
 * For every client on billing_mode='card_per_order', finds recently-completed
 * orders that haven't been billed yet and charges their saved card same-day
 * (or sends a Stripe payment link if no card on file). Replaces monthly net-30
 * Mercury invoicing for those clients.
 *
 * ROLLOUT SAFETY: real charges only happen when CARD_PER_ORDER_AUTOCHARGE=true.
 * Until then it runs in SHADOW mode — logs exactly what it WOULD charge and
 * moves no money. Flip the env var to go live.
 *
 * GET /api/cron/same-day-invoice — Auth: Vercel cron Bearer secret.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';
import { billCompletedEntity, type OrderBillClient } from '@/lib/order-billing';

export const maxDuration = 60;
export const runtime = 'nodejs';

const WINDOW_DAYS = 7;     // catch-up window; idempotency prevents re-billing
const MAX_PER_RUN = 100;

const CLIENT_COLS =
  'id, name, slug, billing_mode, billing_rate_pdf, billing_ap_email, stripe_customer_id, ' +
  'stripe_payment_method_id, payment_method_status, payment_method_brand, payment_method_last4, ' +
  'address_line1, address_line2, address_city, address_state, address_postal_code, address_country';

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  const admin = createAdminClient();
  const autoCharge = process.env.CARD_PER_ORDER_AUTOCHARGE === 'true';
  const sinceIso = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000).toISOString();

  const { data: clients } = await admin.from('clients')
    .select(CLIENT_COLS).eq('billing_mode', 'card_per_order') as { data: OrderBillClient[] | null };

  if (!clients || clients.length === 0) {
    return NextResponse.json({ success: true, mode: autoCharge ? 'live' : 'shadow', clients: 0, actions: [] });
  }

  const actions: any[] = [];
  let processed = 0;

  for (const client of clients) {
    if (processed >= MAX_PER_RUN) break;
    const { data: ents } = await admin.from('request_entities')
      .select('id, entity_name, gross_receipts, credit_paid, status, updated_at, requests!inner(client_id)')
      .eq('requests.client_id', client.id)
      .eq('status', 'completed')
      .gte('updated_at', sinceIso) as { data: any[] | null };

    for (const e of ents || []) {
      if (processed >= MAX_PER_RUN) break;
      processed++;
      try {
        const r = await billCompletedEntity(admin, e, client, !autoCharge);
        if (r.status !== 'skipped') actions.push({ client: client.name, ...r });
      } catch (err: any) {
        actions.push({ client: client.name, entity_id: e.id, status: 'error', detail: err?.message });
      }
    }
  }

  if (actions.length) console.log(`[same-day-invoice] ${autoCharge ? 'LIVE' : 'SHADOW'}\n` + JSON.stringify(actions, null, 2));

  return NextResponse.json({
    success: true,
    mode: autoCharge ? 'live' : 'shadow',
    clients: clients.length,
    processed,
    charged: actions.filter(a => a.status === 'charged').length,
    payment_links: actions.filter(a => a.status === 'payment_link_sent').length,
    failed: actions.filter(a => a.status === 'payment_failed').length,
    actions,
    processed_at: new Date().toISOString(),
  });
}
