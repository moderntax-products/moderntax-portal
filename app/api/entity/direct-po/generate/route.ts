/**
 * POST /api/entity/direct-po/generate
 *
 * Team endpoint. Builds (or rebuilds) a ModernTax Direct Purchase Order for an
 * entity from its detected situation and persists it on
 * gross_receipts.purchase_order, minting a public `direct_token` if one doesn't
 * exist yet. The taxpayer then reviews + pays the PO at /direct/[token].
 *
 * Body: { entityId: string }
 * Auth: admin, or a logged-in user on the entity's client.
 *
 * Idempotent-ish: regenerating overwrites a `draft` PO with a fresh
 * recommendation but preserves an already `approved`/`paid` PO (returns it
 * untouched) so we never wipe a paid engagement.
 *
 * Matt 2026-07-27.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import {
  detectSituation,
  recommendLineItems,
  buildPurchaseOrder,
  makePoNumber,
} from '@/lib/direct-purchase-order';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function token(entityId: string): string {
  // Deterministic-enough public token: entity id (no dashes) + a rotating
  // suffix from the current ms. Unguessable in practice for our volume.
  return `d_${entityId.replace(/-/g, '')}${Date.now().toString(36)}`;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as { entityId?: string } | null;
    const entityId = body?.entityId?.trim();
    if (!entityId) return NextResponse.json({ error: 'entityId required' }, { status: 400 });

    const cookieStore = await cookies();
    const sb = createServerRouteClient(cookieStore);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    const { data: profile } = await sb.from('profiles').select('role, client_id').eq('id', user.id).single() as {
      data: { role: string | null; client_id: string | null } | null;
    };
    if (!profile) return NextResponse.json({ error: 'No profile' }, { status: 403 });

    const admin = createAdminClient();
    const { data: entity } = await admin.from('request_entities')
      .select('id, entity_name, form_type, gross_receipts, requests!inner(client_id, clients(credit_balance))')
      .eq('id', entityId).single() as { data: any };
    if (!entity) return NextResponse.json({ error: 'Entity not found' }, { status: 404 });

    const isAdmin = profile.role === 'admin';
    if (!isAdmin && entity.requests?.client_id !== profile.client_id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const gr = entity.gross_receipts || {};
    const existing = gr.purchase_order;
    const publicToken = gr.direct_token || token(entityId);

    // Never wipe a live engagement.
    if (existing && (existing.status === 'approved' || existing.status === 'paid')) {
      return NextResponse.json({ po: existing, token: publicToken, regenerated: false });
    }

    const situation = detectSituation(gr, entity.form_type);
    const lineItems = recommendLineItems(situation);
    if (!lineItems.length) {
      return NextResponse.json({ error: 'No billable services detected for this entity yet.' }, { status: 409 });
    }

    const createdAt = new Date().toISOString();
    const creditAvailable = Number(entity.requests?.clients?.credit_balance) || 0;
    const po = buildPurchaseOrder({
      entityId,
      entityName: entity.entity_name,
      lineItems,
      creditAvailable,
      createdAt,
      poNumber: makePoNumber(entityId, createdAt),
      status: 'draft',
    });

    const newGr = { ...gr, purchase_order: po, direct_token: publicToken };
    const { error: upErr } = await (admin.from('request_entities') as any)
      .update({ gross_receipts: newGr }).eq('id', entityId);
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

    return NextResponse.json({ po, token: publicToken, situation, regenerated: true });
  } catch (err: any) {
    console.error('[direct-po/generate]', err);
    return NextResponse.json({ error: err?.message || 'Generate failed' }, { status: 500 });
  }
}
