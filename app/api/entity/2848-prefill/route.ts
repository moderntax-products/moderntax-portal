/**
 * GET /api/entity/2848-prefill?entityId=<uuid>
 *
 * Returns a Form 2848 (Power of Attorney) PDF pre-filled with the TAXPAYER's
 * info (name, TIN, address) from the entity, the generic ModernTax
 * representative (blank CAF), and Section 3 acts derived from the entity's
 * form_type + years. Part II (the Circular 230 declaration) and the taxpayer
 * signature are left blank for execution.
 *
 * Companion to /api/entity/8821-prefill — built 2026-06-20 for the ModernTax
 * Direct workflow ("just need to be able to download it populated with the
 * taxpayer's info"). The taxpayer prints, signs, and returns it; the
 * representing practitioner completes Part II at signing.
 *
 * Auth: authenticated processor/manager/admin whose client owns the entity
 * (admins may pull any entity), or a CRON_SECRET bearer for ops. No DB writes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { generate2848PDF, type Act2848 } from '@/lib/2848-pdf';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** Description of Matter for Section 3, derived from the entity's form type. */
function matterForForm(raw: string | null | undefined): string {
  const v = (raw || '').toUpperCase();
  if (['941', '943', '944', '945', '940'].includes(v)) return 'Employment';
  if (v === 'W2_INCOME') return 'Income';
  return 'Income'; // 1040 / 1120 / 1120S / 1065 / 990 / 1041
}

function normalizeTinKind(raw: string | null | undefined): 'SSN' | 'EIN' | 'ITIN' {
  const v = (raw || '').toUpperCase();
  if (v === 'EIN') return 'EIN';
  if (v === 'ITIN') return 'ITIN';
  return 'SSN';
}

/** Year/period formatting — contiguous → range, else compact list. */
function formatYears(years: number[]): string {
  if (!years || years.length === 0) return '';
  const sorted = [...new Set(years)].sort((a, b) => a - b);
  if (sorted.length === 1) return String(sorted[0]);
  const contiguous = sorted.every((y, i) => i === 0 || y === sorted[i - 1] + 1);
  if (contiguous) return `${sorted[0]}-${sorted[sorted.length - 1]}`;
  return sorted.join(', ');
}

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization') || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const isServiceCaller = !!process.env.CRON_SECRET && bearer === process.env.CRON_SECRET;

    let profile: { role: string | null; client_id: string | null } | null = null;
    if (isServiceCaller) {
      profile = { role: 'admin', client_id: null };
    } else {
      const cookieStore = await cookies();
      const supabase = createServerRouteClient(cookieStore);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
      const { data } = await supabase
        .from('profiles').select('role, client_id').eq('id', user.id).single() as {
          data: { role: string | null; client_id: string | null } | null;
        };
      profile = data;
    }
    if (!profile) return NextResponse.json({ error: 'No profile' }, { status: 403 });

    const entityId = new URL(request.url).searchParams.get('entityId')?.trim();
    if (!entityId) return NextResponse.json({ error: 'entityId query param required' }, { status: 400 });

    const admin = createAdminClient();
    const { data: entity } = await admin.from('request_entities')
      .select('id, entity_name, tid, tid_kind, form_type, years, address, city, state, zip_code, requests!inner(client_id)')
      .eq('id', entityId)
      .single() as { data: any };
    if (!entity) return NextResponse.json({ error: 'Entity not found' }, { status: 404 });

    const isAdmin = profile.role === 'admin';
    const ownsEntity = profile.client_id && entity.requests?.client_id === profile.client_id;
    if (!isAdmin && !ownsEntity) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const cityStateZip = [
      [entity.city, entity.state].filter(Boolean).join(', '),
      entity.zip_code,
    ].filter(Boolean).join(' ').trim();
    const fullAddress = [entity.address, cityStateZip].filter(Boolean).join(', ');
    const yearsArr: number[] = (entity.years || []).map((y: any) => parseInt(String(y), 10)).filter(Number.isFinite);

    const acts: Act2848[] = [{
      description: matterForForm(entity.form_type),
      form: entity.form_type || '',
      years: formatYears(yearsArr),
    }];

    const pdfBuffer = await generate2848PDF({
      taxpayer: {
        name: entity.entity_name || '',
        address: fullAddress,
        tin: entity.tid || '',
        tinKind: normalizeTinKind(entity.tid_kind),
      },
      acts,
    });

    const safeName = (entity.entity_name || 'entity').replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 40);
    return new NextResponse(new Uint8Array(pdfBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="2848-${safeName}.pdf"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err: any) {
    console.error('[entity/2848-prefill] error:', err);
    return NextResponse.json(
      { error: 'Failed to generate pre-filled 2848', detail: err?.message || String(err) },
      { status: 500 },
    );
  }
}
