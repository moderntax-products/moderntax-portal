/**
 * POST /api/entity/filing-intake
 *
 * Saves a ModernTax Direct taxpayer's filing-intake answers (and, when they
 * click "Authorize & submit", their authorization to prepare the returns) to
 * the entity's gross_receipts.filing_intake. Persisted so they can return to a
 * half-finished form and so the team prepares returns from it.
 *
 * Body: { entityId: string, answers: object, authorize?: boolean }
 * Auth: the logged-in user must own the entity's client (admins exempt).
 *
 * Matt 2026-06-23.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as { entityId?: string; answers?: any; authorize?: boolean } | null;
    const entityId = body?.entityId?.trim();
    if (!entityId || !body?.answers) return NextResponse.json({ error: 'entityId and answers required' }, { status: 400 });

    const cookieStore = await cookies();
    const sb = createServerRouteClient(cookieStore);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    const { data: profile } = await sb.from('profiles').select('role, client_id, full_name, email').eq('id', user.id).single() as {
      data: { role: string | null; client_id: string | null; full_name: string | null; email: string } | null;
    };
    if (!profile) return NextResponse.json({ error: 'No profile' }, { status: 403 });

    const admin = createAdminClient();
    const { data: entity } = await admin.from('request_entities')
      .select('id, gross_receipts, requests!inner(client_id)').eq('id', entityId).single() as { data: any };
    if (!entity) return NextResponse.json({ error: 'Entity not found' }, { status: 404 });
    if (profile.role !== 'admin' && entity.requests?.client_id !== profile.client_id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const now = new Date().toISOString();
    const gr = entity.gross_receipts || {};
    const prior = gr.filing_intake || {};
    const filing_intake = {
      ...prior,
      answers: body.answers,
      updated_at: now,
      ...(body.authorize ? {
        authorized: true,
        authorized_at: prior.authorized_at || now,
        authorized_by: profile.full_name || profile.email,
      } : {}),
    };

    const { error } = await (admin.from('request_entities') as any)
      .update({ gross_receipts: { ...gr, filing_intake } }).eq('id', entityId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ success: true, authorized: !!filing_intake.authorized });
  } catch (err: any) {
    console.error('[entity/filing-intake]', err);
    return NextResponse.json({ error: err?.message || 'Save failed' }, { status: 500 });
  }
}
