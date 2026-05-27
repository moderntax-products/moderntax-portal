/**
 * POST /api/admin/centerstone-may-cleanup
 *
 * Phase 1 of Matt's 2026-05-27 directives after the Mathew Paek call.
 *   1. Cancel R2 Mercury invoice ($1,712.28)
 *   2. Mark local invoices row as cancelled
 *   3. Remove Jasmine Kim from Centerstone billing_ap_email_cc
 *
 * Idempotent — safe to re-run; already-cancelled invoices return 4xx
 * from Mercury and we treat that as success.
 *
 * Auth: CRON_SECRET only.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const CENTERSTONE_CLIENT_ID = '60f80d60-03ad-42d7-95da-c0f1cd311523';
const CENTERSTONE_LOCAL_INV = '2050bc3d-b99b-4f06-8ec8-ebd45da93894';
const R2_MERCURY_ID         = '92471498-59f5-11f1-a03f-1b816b198f09';

export async function POST(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;
  const log: string[] = [];
  const L = (s: string) => { console.log('[centerstone-may-cleanup]', s); log.push(s); };

  // 1. Cancel R2 Mercury invoice
  const mercuryKey = process.env.MERCURY_API_KEY;
  if (!mercuryKey) return NextResponse.json({ error: 'MERCURY_API_KEY missing', log }, { status: 500 });
  try {
    const r = await fetch(`https://api.mercury.com/api/v1/ar/invoices/${R2_MERCURY_ID}/cancel`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${mercuryKey}`, 'Content-Type': 'application/json' },
    });
    if (r.ok) L(`✓ Cancelled R2 Mercury invoice ${R2_MERCURY_ID}`);
    else L(`! Cancel returned ${r.status}: ${(await r.text()).slice(0, 200)} — proceeding anyway (already cancelled?)`);
  } catch (err: any) {
    L(`! Mercury cancel threw: ${err.message}`);
  }

  // 2. Mark local invoices row as cancelled. Per Matt, the authoritative
  // May invoice will fire from the cron on 5/31 — this row was already
  // mutated through R1/R2 attempts so we wipe Mercury references too.
  const admin = createAdminClient();
  await (admin.from('invoices') as any).update({
    status: 'cancelled',
    mercury_invoice_id: null,
    mercury_invoice_slug: null,
    mercury_pay_url: null,
    mercury_pdf_url: null,
    mercury_reference: null,
    notes: 'Cancelled 2026-05-27 after Mathew Paek call. Authoritative May invoice will fire from cron on 5/31 at end-of-day with verification only (no 8821 surcharge, no monitoring) per the revised contract terms.',
  }).eq('id', CENTERSTONE_LOCAL_INV);
  L('✓ Local invoices row marked cancelled, Mercury refs cleared');

  // 3. Remove Jasmine from Centerstone billing_ap_email_cc
  const { data: client } = await admin.from('clients')
    .select('billing_ap_email_cc, billing_ap_email')
    .eq('id', CENTERSTONE_CLIENT_ID).single() as { data: any };
  const oldCcs = client.billing_ap_email_cc || [];
  const newCcs = oldCcs.filter((e: string) => !/jasmine/i.test(e));
  L(`CC list: ${JSON.stringify(oldCcs)} → ${JSON.stringify(newCcs)}`);
  await (admin.from('clients') as any).update({ billing_ap_email_cc: newCcs }).eq('id', CENTERSTONE_CLIENT_ID);
  L('✓ Jasmine removed from Centerstone billing_ap_email_cc');

  return NextResponse.json({
    success: true,
    log,
    mercury_cancelled: R2_MERCURY_ID,
    local_invoice_cancelled: CENTERSTONE_LOCAL_INV,
    centerstone_cc_now: newCcs,
  });
}
