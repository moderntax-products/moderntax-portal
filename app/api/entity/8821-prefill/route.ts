/**
 * GET /api/entity/8821-prefill?entityId=<uuid>
 *
 * Customer/processor-facing endpoint that returns a Form 8821 PDF with the
 * TAXPAYER section (Section 1) pre-filled from the entity the caller entered
 * (name, TIN, address) and the ModernTax house designee baked into Section 2
 * (DESIGNEES.default — LaTonya Holmes C/O ModernTax Inc). Section 3 is filled
 * from the entity's form_type + years.
 *
 * Why this exists (2026-06-01, Erin Wilsey / Banc of California bug):
 * The Processor8821Panel previously linked to STATIC blank templates at
 * /public/templates/8821-individual.pdf and /8821-business.pdf. Those files
 * carry the ModernTax designee block but an EMPTY taxpayer Section 1, so
 * clicking "8821 Individual"/"8821 Business" handed the processor a generic
 * form with none of the entity/individual info they'd just typed in. Erin
 * reported "when I select either one, it's not filling in the entity or
 * individual's information." This endpoint generates the per-entity, fully
 * pre-filled 8821 instead so the borrower only has to sign.
 *
 * Auth: authenticated user (processor/manager/admin). The entity must belong
 * to the caller's client_id (admins may pull any entity). No expert is
 * assigned at this pre-signature stage, so the house designee is used — the
 * actual assigned-expert designee is stamped later by the admin/expert flow
 * when the signed form is processed.
 *
 * Returns application/pdf with a download disposition. No DB writes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { generate8821PDF, DESIGNEES } from '@/lib/8821-pdf';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Form8821Type = '1040' | '1065' | '1120' | '1120S' | '990' | '1041' | '941';

/** Map an entity's stored form_type onto a 8821-supported form type. */
function normalizeFormType(raw: string | null | undefined): Form8821Type {
  const v = (raw || '').toUpperCase();
  switch (v) {
    case '1065': return '1065';
    case '1120': return '1120';
    case '1120S': return '1120S';
    case '990': return '990';
    case '1041': return '1041';
    case '941': return '941';
    case 'W2_INCOME': // W-2 wage income is an individual matter
    case '1040':
    default:
      return '1040';
  }
}

/** Same Section 3 year formatting rule the admin generator uses. */
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

export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const { data: profile } = await supabase
      .from('profiles').select('role, client_id').eq('id', user.id).single() as {
        data: { role: string | null; client_id: string | null } | null;
      };
    if (!profile) return NextResponse.json({ error: 'No profile' }, { status: 403 });

    const entityId = new URL(request.url).searchParams.get('entityId')?.trim();
    if (!entityId) return NextResponse.json({ error: 'entityId query param required' }, { status: 400 });

    const admin = createAdminClient();

    // Load the entity + the owning request's client_id for the ownership check.
    const { data: entity } = await admin.from('request_entities')
      .select('id, entity_name, tid, tid_kind, form_type, years, address, city, state, zip_code, request_id, requests!inner(client_id)')
      .eq('id', entityId)
      .single() as { data: any };
    if (!entity) return NextResponse.json({ error: 'Entity not found' }, { status: 404 });

    const isAdmin = profile.role === 'admin';
    const ownsEntity = profile.client_id && entity.requests?.client_id === profile.client_id;
    if (!isAdmin && !ownsEntity) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const formType = normalizeFormType(entity.form_type);
    const entityAddress = [entity.address, entity.city, entity.state, entity.zip_code]
      .filter(Boolean).join(', ') || '';
    const yearsArr: number[] = (entity.years || [])
      .map((y: any) => parseInt(String(y), 10))
      .filter(Number.isFinite);

    const pdfBuffer = await generate8821PDF({
      taxpayer: {
        name: entity.entity_name || '',
        tin: entity.tid || '',
        address: entityAddress,
      },
      designee: DESIGNEES.default,
      formType,
      years: formatYears(yearsArr),
    });

    const safeName = (entity.entity_name || 'entity').replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 40);
    const filename = `8821-${safeName}.pdf`;

    return new NextResponse(new Uint8Array(pdfBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err: any) {
    console.error('[entity/8821-prefill] error:', err);
    return NextResponse.json(
      { error: 'Failed to generate pre-filled 8821', detail: err?.message || String(err) },
      { status: 500 },
    );
  }
}
