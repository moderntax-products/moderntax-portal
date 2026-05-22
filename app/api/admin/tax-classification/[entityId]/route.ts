/**
 * GET  /api/admin/tax-classification/[entityId]
 *   Runs the detector against the entity's current transcript inventory
 *   and returns the structured Tax Classification Status block. Also
 *   persists the result to request_entities.tax_classification_mismatch
 *   so the admin panel can render without re-running on every load.
 *
 * POST /api/admin/tax-classification/[entityId]
 *   Update the entity's 2553 status (PPS agent dictates after a call).
 *   Body: { form_2553_status: Form2553Status, set_check_requested?: boolean }
 *
 * PATCH /api/admin/tax-classification/[entityId]
 *   Toggle the tax_classification_check_requested flag (intake-time decision).
 *   Body: { tax_classification_check_requested: boolean }
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { runTaxClassificationDetection, type Form2553Status } from '@/lib/tax-classification-runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PageProps { params: Promise<{ entityId: string }> }

async function requireAdmin(): Promise<{ ok: true } | NextResponse> {
  const cookieStore = await cookies();
  const supabase = createServerRouteClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single() as { data: { role: string } | null };
  if (!profile || profile.role !== 'admin') {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 });
  }
  return { ok: true };
}

export async function GET(_request: NextRequest, { params }: PageProps) {
  const gate = await requireAdmin();
  if (gate instanceof NextResponse) return gate;
  const { entityId } = await params;
  const result = await runTaxClassificationDetection(entityId);
  return NextResponse.json(result);
}

export async function POST(request: NextRequest, { params }: PageProps) {
  const gate = await requireAdmin();
  if (gate instanceof NextResponse) return gate;
  const { entityId } = await params;
  const body = await request.json().catch(() => ({}));
  const admin = createAdminClient();

  if (body.form_2553_status) {
    const s: Form2553Status = body.form_2553_status;
    await (admin.from('request_entities') as any).update({
      form_2553_status: s,
      ...(body.set_check_requested ? { tax_classification_check_requested: true } : {}),
    }).eq('id', entityId);
    // Re-run detection now that 2553 status is set
    const result = await runTaxClassificationDetection(entityId);
    return NextResponse.json(result);
  }

  return NextResponse.json({ error: 'No supported body field present' }, { status: 400 });
}

export async function PATCH(request: NextRequest, { params }: PageProps) {
  const gate = await requireAdmin();
  if (gate instanceof NextResponse) return gate;
  const { entityId } = await params;
  const body = await request.json().catch(() => ({}));
  if (typeof body.tax_classification_check_requested !== 'boolean') {
    return NextResponse.json({ error: 'tax_classification_check_requested boolean required' }, { status: 400 });
  }
  const admin = createAdminClient();
  await (admin.from('request_entities') as any).update({
    tax_classification_check_requested: body.tax_classification_check_requested,
  }).eq('id', entityId);
  return NextResponse.json({ ok: true });
}
