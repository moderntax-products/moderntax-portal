/**
 * POST /api/webhook/sinch-fax?entityId=<uuid>&secret=<shared>
 *
 * Sinch Fax delivery callback — updates the matching gross_receipts.faxes[]
 * entry on the entity with the terminal status (COMPLETED / FAILURE), so the
 * expert dashboard shows real delivery confirmation for IRS faxes.
 *
 * Auth: shared secret in the query string (we mint the callback URL ourselves
 * in /api/expert/fax-8821, so the secret never appears anywhere else). The
 * expert-facing GET also polls Sinch as a fallback if a callback is missed.
 *
 * Sinch posts JSON (event + fax object) or multipart (when including the
 * fax image) — we only need id + status, and tolerate both shapes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  try {
    const secret = process.env.SINCH_FAX_CALLBACK_SECRET || process.env.CRON_SECRET || '';
    const presented = request.nextUrl.searchParams.get('secret') || '';
    if (!secret || presented !== secret) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
    const entityId = request.nextUrl.searchParams.get('entityId')?.trim();
    if (!entityId) return NextResponse.json({ error: 'entityId required' }, { status: 400 });

    // Tolerate JSON and multipart callback bodies.
    let payload: any = null;
    const ctype = request.headers.get('content-type') || '';
    if (ctype.includes('application/json')) {
      payload = await request.json().catch(() => null);
    } else if (ctype.includes('multipart/form-data')) {
      const form = await request.formData().catch(() => null);
      const raw = form?.get('fax') || form?.get('event') || null;
      if (typeof raw === 'string') { try { payload = JSON.parse(raw); } catch { payload = null; } }
    } else {
      payload = await request.json().catch(() => null);
    }

    const fax = payload?.fax || payload || {};
    const faxId: string = fax.id || fax.faxId || '';
    const status: string = fax.status || payload?.status || '';
    if (!faxId || !status) {
      console.warn('[sinch-fax-webhook] payload missing id/status — acknowledging anyway');
      return NextResponse.json({ ok: true, ignored: true });
    }

    const admin = createAdminClient();
    const { data: entity } = await admin.from('request_entities')
      .select('id, gross_receipts').eq('id', entityId).single() as { data: any };
    if (!entity) return NextResponse.json({ ok: true, ignored: true });

    const gr = entity.gross_receipts || {};
    const faxes: any[] = Array.isArray(gr.faxes) ? gr.faxes : [];
    const entry = faxes.find((f) => f.fax_id === faxId);
    if (!entry) return NextResponse.json({ ok: true, ignored: true });

    entry.status = status;
    entry.updated_at = new Date().toISOString();
    if (fax.errorMessage || fax.errorCode) entry.error = fax.errorMessage || String(fax.errorCode);

    await (admin.from('request_entities') as any)
      .update({ gross_receipts: { ...gr, faxes } }).eq('id', entityId);

    console.log(`[sinch-fax-webhook] fax ${faxId} → ${status} (entity ${entityId.slice(0, 8)})`);
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[sinch-fax-webhook] error:', err?.message || err);
    // Always 200 so Sinch doesn't retry-storm; the GET poll is the fallback.
    return NextResponse.json({ ok: false });
  }
}
