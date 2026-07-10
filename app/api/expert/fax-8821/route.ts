/**
 * Expert-dashboard faxing — POST/GET /api/expert/fax-8821
 *
 * POST { entityId, toNumber } — fax the entity's 8821 (the ADMIN-prepared
 * expert copy when present, else the signed processor copy) to the IRS from
 * inside the dashboard, via the Sinch Fax API. Replaces the broken offline
 * fax workflow. The expert types the destination (the CAF-unit fax or the
 * number a PPS rep gives on a call).
 *
 * GET ?entityId= — the entity's fax history (from gross_receipts.faxes) so
 * the card can render current status; entries are updated by the Sinch
 * delivery callback (/api/webhook/sinch-fax) with a poll fallback here for
 * stale QUEUED/IN_PROGRESS entries.
 *
 * Auth: the assigned expert (active assignment on the entity) or an admin.
 * Fax log lives in gross_receipts.faxes[] — no new table needed.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { sendSinchFax, getSinchFax, sinchConfigured, normalizeFaxNumber } from '@/lib/sinch-fax';
import { logAuditFromRequest } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io';

async function authorize(entityId: string) {
  const cookieStore = await cookies();
  const sb = createServerRouteClient(cookieStore);
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) } as const;

  const { data: profile } = await sb.from('profiles')
    .select('id, role, full_name, caf_number').eq('id', user.id).single() as { data: any };
  if (!profile || !['expert', 'admin'].includes(profile.role)) {
    return { error: NextResponse.json({ error: 'Not authorized' }, { status: 403 }) } as const;
  }

  const admin = createAdminClient();
  if (profile.role !== 'admin') {
    const { data: asn } = await admin.from('expert_assignments')
      .select('id').eq('entity_id', entityId).eq('expert_id', user.id)
      .in('status', ['assigned', 'in_progress']).limit(1) as { data: any[] | null };
    if (!asn?.length) {
      return { error: NextResponse.json({ error: 'No active assignment on this entity' }, { status: 403 }) } as const;
    }
  }
  return { admin, user, profile } as const;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as { entityId?: string; toNumber?: string } | null;
    const entityId = body?.entityId?.trim();
    if (!entityId) return NextResponse.json({ error: 'entityId required' }, { status: 400 });

    const auth = await authorize(entityId);
    if ('error' in auth) return auth.error;
    const { admin, user, profile } = auth;

    if (!sinchConfigured()) {
      return NextResponse.json({
        error: 'Fax service not configured yet — SINCH_PROJECT_ID / SINCH_ACCESS_KEY / SINCH_ACCESS_SECRET must be set in Vercel.',
        code: 'not_configured',
      }, { status: 503 });
    }

    const to = normalizeFaxNumber(body?.toNumber);
    if (!to) return NextResponse.json({ error: 'Enter a valid US fax number (10 digits, or E.164 like +18552147522).' }, { status: 400 });

    const { data: entity } = await admin.from('request_entities')
      .select('id, entity_name, gross_receipts, admin_uploaded_8821_url, signed_8821_url')
      .eq('id', entityId).single() as { data: any };
    if (!entity) return NextResponse.json({ error: 'Entity not found' }, { status: 404 });

    // Experts must fax THEIR copy (admin-prepared, their CAF as designee).
    const docPath = entity.admin_uploaded_8821_url || entity.signed_8821_url;
    if (!docPath) return NextResponse.json({ error: 'No 8821 on file for this entity yet.' }, { status: 409 });

    // Sinch pulls the content from a URL — 1 hour is plenty for render + retries.
    const { data: signed } = await admin.storage.from('uploads').createSignedUrl(docPath, 3600);
    if (!signed?.signedUrl) return NextResponse.json({ error: 'Could not create a document link.' }, { status: 500 });

    const cbSecret = process.env.SINCH_FAX_CALLBACK_SECRET || process.env.CRON_SECRET || '';
    const callbackUrl = cbSecret
      ? `${APP_URL}/api/webhook/sinch-fax?entityId=${entityId}&secret=${encodeURIComponent(cbSecret)}`
      : undefined;

    const fax = await sendSinchFax({
      to,
      contentUrl: signed.signedUrl,
      callbackUrl,
      headerText: `ModernTax 8821 - ${entity.entity_name}`.slice(0, 60),
    });

    // Log on the entity (gross_receipts.faxes[]) — callback updates status later.
    const gr = entity.gross_receipts || {};
    const faxes = Array.isArray(gr.faxes) ? gr.faxes : [];
    faxes.push({
      fax_id: fax.id, to, status: fax.status || 'QUEUED',
      doc: docPath, sent_at: new Date().toISOString(),
      by: profile.full_name || user.email, by_id: user.id, provider: 'sinch',
    });
    await (admin.from('request_entities') as any)
      .update({ gross_receipts: { ...gr, faxes } }).eq('id', entityId);

    await logAuditFromRequest(admin, request, {
      action: 'fax_sent',
      userId: user.id,
      resourceType: 'entity',
      resourceId: entityId,
      details: { provider: 'sinch', fax_id: fax.id, to, doc: docPath },
    });

    return NextResponse.json({ success: true, faxId: fax.id, status: fax.status || 'QUEUED', to });
  } catch (err: any) {
    console.error('[expert/fax-8821] error:', err?.message || err);
    return NextResponse.json({ error: err?.message || 'Fax send failed' }, { status: 502 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const entityId = request.nextUrl.searchParams.get('entityId')?.trim();
    if (!entityId) return NextResponse.json({ error: 'entityId required' }, { status: 400 });

    const auth = await authorize(entityId);
    if ('error' in auth) return auth.error;
    const { admin } = auth;

    const { data: entity } = await admin.from('request_entities')
      .select('gross_receipts').eq('id', entityId).single() as { data: any };
    const gr = entity?.gross_receipts || {};
    const faxes: any[] = Array.isArray(gr.faxes) ? gr.faxes : [];

    // Live-confirmation path: the card polls this endpoint every ~8s after a
    // send, so refresh any non-terminal entry from Sinch once it's >15s old —
    // the expert needs "Delivered" on screen while still on the phone with
    // the IRS agent (the callback is the fast path; this is the guarantee).
    let changed = false;
    for (const f of faxes) {
      const terminal = ['COMPLETED', 'FAILURE', 'FAILED', 'DELIVERED'].includes((f.status || '').toUpperCase());
      const stale = Date.now() - Date.parse(f.updated_at || f.sent_at || 0) > 15 * 1000;
      if (!terminal && stale && f.fax_id) {
        const live = await getSinchFax(f.fax_id);
        if (live?.status && live.status !== f.status) { f.status = live.status; f.updated_at = new Date().toISOString(); changed = true; }
      }
    }
    if (changed) {
      await (admin.from('request_entities') as any)
        .update({ gross_receipts: { ...gr, faxes } }).eq('id', entityId);
    }

    return NextResponse.json({ faxes: faxes.slice(-10).reverse() });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Failed to load fax history' }, { status: 500 });
  }
}
