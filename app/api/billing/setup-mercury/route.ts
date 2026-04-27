/**
 * POST /api/billing/setup-mercury
 *
 * One-time enrollment: creates the Mercury customer record so future
 * invoices auto-populate with the manager's billing details. The
 * payer-facing ACH authorization happens on Mercury's side when the
 * manager pays their first invoice (Mercury saves the bank info for
 * subsequent invoices).
 *
 * Requires: AP email + billing address already saved on the client.
 *
 * Body: {} (uses existing client billing settings)
 *
 * Returns: { mercury_customer_id, customer_name }
 */

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { findOrCreateMercuryCustomer } from '@/lib/mercury';

export async function POST() {
  const cookieStore = await cookies();
  const supabase = createServerRouteClient(cookieStore);

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, client_id')
    .eq('id', user.id)
    .single() as { data: { role: string; client_id: string | null } | null; error: any };

  if (!profile || !['manager', 'admin'].includes(profile.role) || !profile.client_id) {
    return NextResponse.json({ error: 'Manager-only' }, { status: 403 });
  }

  const admin = createAdminClient();
  const { data: client } = await (admin.from('clients' as any) as any)
    .select('id, name, mercury_customer_id, billing_ap_email, address_line1, address_line2, address_city, address_state, address_postal_code, address_country')
    .eq('id', profile.client_id)
    .single();

  if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 });

  // Validation — Mercury requires email at minimum, address strongly recommended
  if (!client.billing_ap_email) {
    return NextResponse.json({
      error: 'Add an AP email first',
      detail: 'Mercury sends invoice notifications and pay-page links to this address.',
    }, { status: 400 });
  }
  if (!client.address_line1 || !client.address_city || !client.address_state || !client.address_postal_code) {
    return NextResponse.json({
      error: 'Add a complete billing address first',
      detail: 'Mercury requires street, city, state, and ZIP for invoice generation.',
    }, { status: 400 });
  }

  if (client.mercury_customer_id) {
    return NextResponse.json({
      success: true,
      mercury_customer_id: client.mercury_customer_id,
      customer_name: client.name,
      already_existed: true,
      message: 'Already enrolled — your invoices and pay pages are wired to Mercury.',
    });
  }

  let mercuryCustomerId: string;
  try {
    const customer = await findOrCreateMercuryCustomer({
      name: client.name,
      email: client.billing_ap_email,
      address: {
        name: client.name,
        address1: client.address_line1,
        address2: client.address_line2 || null,
        city: client.address_city,
        region: client.address_state,
        postalCode: client.address_postal_code,
        country: client.address_country || 'US',
      },
    });
    mercuryCustomerId = customer.id;
  } catch (err: any) {
    return NextResponse.json({
      error: 'Mercury setup failed',
      detail: err?.message || String(err),
    }, { status: 500 });
  }

  await (admin.from('clients' as any) as any)
    .update({ mercury_customer_id: mercuryCustomerId })
    .eq('id', client.id);

  return NextResponse.json({
    success: true,
    mercury_customer_id: mercuryCustomerId,
    customer_name: client.name,
    message: 'Enrolled. Future invoices will reference this Mercury customer; payer-side ACH authorization happens when you pay your first invoice.',
  });
}
