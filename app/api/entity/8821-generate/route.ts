/**
 * POST /api/entity/8821-generate
 *
 * Processor-facing: generate a fully-populated (unsigned) Form 8821, store it,
 * email a copy to the ordering processor, and return a 1-hour download URL.
 *
 * Two input modes:
 *   1. { entityId }              — pull taxpayer data from a saved entity
 *      (post-order path, from Processor8821Panel).
 *   2. { entityName, tid, ... }  — raw order fields from the NEW-ORDER form,
 *      BEFORE the order is saved (the manual-entry download button). This is
 *      the gap the BFC demo surfaced: a processor could only download an 8821
 *      after creating the order and finding the request page. Now they can
 *      generate + email it straight from the ordering screen.
 *
 * Section 2 is the ModernTax house designee (DESIGNEES.default) — the same
 * designee the post-order prefill endpoint stamps, so what the processor
 * downloads here matches what they'd get later on the request page.
 *
 * Auth: processor / manager / admin. For the entityId mode the entity must
 * belong to the caller's client (admins may pull any).
 *
 * Returns { url, emailed, filename } — with a base64 fallback if storage is
 * unavailable so the download never hard-fails.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { generate8821PDF, DESIGNEES } from '@/lib/8821-pdf';
import { send8821ToProcessor } from '@/lib/sendgrid';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Form8821Type = '1040' | '1065' | '1120' | '1120S' | '990' | '1041' | '941';

function normalizeFormType(raw: string | null | undefined): Form8821Type {
  const v = (raw || '').toUpperCase();
  switch (v) {
    case '1065': return '1065';
    case '1120': return '1120';
    case '1120S': return '1120S';
    case '990': return '990';
    case '1041': return '1041';
    case '941': return '941';
    case 'W2_INCOME':
    case '1040':
    default:
      return '1040';
  }
}

function formatYears(years: number[]): string {
  if (!years || years.length === 0) return '2022-2026';
  const sorted = [...new Set(years)].sort((a, b) => a - b);
  if (sorted.length === 1) return String(sorted[0]);
  const contiguous = sorted.every((y, i) => i === 0 || y === sorted[i - 1] + 1);
  if (contiguous) return `${sorted[0]}-${sorted[sorted.length - 1]}`;
  const list = sorted.join(', ');
  if (list.length <= 21) return list;
  return `${sorted[0]}-${sorted[sorted.length - 1]}`;
}

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const { data: profile } = await supabase
      .from('profiles').select('role, client_id, full_name').eq('id', user.id).single() as {
        data: { role: string | null; client_id: string | null; full_name: string | null } | null;
      };
    if (!profile || !['processor', 'manager', 'admin'].includes(profile.role || '')) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    const wantEmail = body.email !== false; // default: email the processor

    let taxpayerName = '';
    let tin = '';
    let formTypeRaw: string | null | undefined;
    let yearsRaw: any[] = [];
    let address = '';
    let city = '';
    let stateCode = '';
    let zipCode = '';
    let storageEntityId: string | null = null;

    if (body.entityId) {
      const admin = createAdminClient();
      const { data: entity } = await admin.from('request_entities')
        .select('id, entity_name, tid, form_type, years, address, city, state, zip_code, requests!inner(client_id)')
        .eq('id', body.entityId)
        .single() as { data: any };
      if (!entity) return NextResponse.json({ error: 'Entity not found' }, { status: 404 });
      const isAdmin = profile.role === 'admin';
      const owns = profile.client_id && entity.requests?.client_id === profile.client_id;
      if (!isAdmin && !owns) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      taxpayerName = entity.entity_name || '';
      tin = entity.tid || '';
      // The request-page panel may pass a form-type / years override the
      // processor changed but hasn't saved yet — honor it so the emailed copy
      // matches what they see (parity with the download button).
      formTypeRaw = body.formType || entity.form_type;
      yearsRaw = (Array.isArray(body.years) && body.years.length > 0) ? body.years : (entity.years || []);
      address = entity.address || '';
      city = entity.city || '';
      stateCode = entity.state || '';
      zipCode = entity.zip_code || '';
      storageEntityId = entity.id;
    } else {
      // Raw order fields from the not-yet-saved new-order form.
      taxpayerName = String(body.entityName || '').trim();
      tin = String(body.tid || '').trim();
      formTypeRaw = body.formType;
      yearsRaw = Array.isArray(body.years) ? body.years : [];
      address = String(body.address || '').trim();
      city = String(body.city || '').trim();
      stateCode = String(body.state || '').trim();
      zipCode = String(body.zipCode || '').trim();
      if (!taxpayerName || !tin) {
        return NextResponse.json({ error: 'Taxpayer name and TIN are required to generate an 8821.' }, { status: 400 });
      }
    }

    const formType = normalizeFormType(formTypeRaw);
    const cityStateZip = [[city, stateCode].filter(Boolean).join(', '), zipCode].filter(Boolean).join(' ').trim();
    const fullAddress = [address, cityStateZip].filter(Boolean).join('\n');
    const yearsArr: number[] = (yearsRaw || [])
      .map((y: any) => parseInt(String(y), 10))
      .filter(Number.isFinite);

    const pdfBuffer = await generate8821PDF({
      taxpayer: { name: taxpayerName, tin, address: fullAddress },
      designee: DESIGNEES.default,
      formType,
      years: formatYears(yearsArr),
    });

    const safeName = (taxpayerName || 'entity').replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 40);
    const filename = `8821-${safeName}.pdf`;

    // Store + sign a 1-hour download URL. Best-effort: if storage is
    // unavailable we still email + return a base64 fallback below.
    const admin = createAdminClient();
    const storagePath = storageEntityId
      ? `8821/${storageEntityId}/${Date.now()}-processor.pdf`
      : `8821/adhoc/${user.id}/${Date.now()}-${safeName}.pdf`;
    let url: string | null = null;
    try {
      const { error: upErr } = await admin.storage.from('uploads').upload(storagePath, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: false,
      });
      if (!upErr) {
        const { data: signed } = await admin.storage.from('uploads').createSignedUrl(storagePath, 3600);
        url = signed?.signedUrl || null;
      } else {
        console.error('[8821-generate] storage upload failed:', upErr.message);
      }
    } catch (e) {
      console.error('[8821-generate] storage error:', e);
    }

    // Email the ordering processor a copy.
    let emailed = false;
    if (wantEmail && user.email) {
      try {
        await send8821ToProcessor({
          processorEmail: user.email,
          processorName: profile.full_name,
          taxpayerName,
          formType,
          pdfBytes: pdfBuffer,
        });
        emailed = true;
      } catch (e) {
        console.error('[8821-generate] processor email failed:', e);
      }
    }

    return NextResponse.json({
      url,
      emailed,
      emailedTo: emailed ? user.email : undefined,
      filename,
      // Fallback so the client can still trigger a download if storage is down.
      pdfBase64: url ? undefined : Buffer.from(pdfBuffer).toString('base64'),
    });
  } catch (err: any) {
    console.error('[entity/8821-generate] error:', err);
    return NextResponse.json(
      { error: 'Failed to generate 8821', detail: err?.message || String(err) },
      { status: 500 },
    );
  }
}
