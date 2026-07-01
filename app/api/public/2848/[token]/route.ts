/**
 * GET /api/public/2848/[token]
 *
 * No-login, token-gated Form 2848 (Power of Attorney) PDF for a ModernTax
 * Direct taxpayer to review + download before authorizing. Built for the ERC
 * check-reissue flow: the IRS will only correct a business's address of record
 * (a prerequisite to reissuing returned refund checks) for the owner directly
 * OR for a representative with a 2848 on file — so a signed 2848 lets ModernTax
 * change the address + request both reissues by phone instead of waiting weeks
 * on a mailed 8822-B.
 *
 * The 2848 is pre-filled from the entity + its gross_receipts.erc_recovery
 * (new mailing address + the 941/ERC quarters). Part II (the representative's
 * Circular 230 declaration) and the taxpayer signature line are left blank for
 * execution. Same trust model as /review + /intake — the signed token alone
 * authorizes this one entity; no PII is echoed except on the taxpayer's own form.
 *
 * Matt 2026-07-01.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { verifyFilingIntakeToken } from '@/lib/intake-tokens';
import { generate2848PDF, type Act2848 } from '@/lib/2848-pdf';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function normalizeTinKind(raw: string | null | undefined): 'SSN' | 'EIN' | 'ITIN' {
  const v = (raw || '').toUpperCase();
  if (v === 'EIN') return 'EIN';
  if (v === 'ITIN') return 'ITIN';
  return 'SSN';
}

/** Format a stored mailing address (object or string) into one line. */
function formatMailing(addr: any, fallback: string): string {
  if (!addr) return fallback;
  if (typeof addr === 'string') return addr;
  const line1 = [addr.address1, addr.address2].filter(Boolean).join(', ');
  const cityStateZip = [
    [addr.city, addr.state].filter(Boolean).join(', '),
    addr.zip,
  ].filter(Boolean).join(' ').trim();
  return [line1, cityStateZip].filter(Boolean).join(', ') || fallback;
}

/** Derive the ERC acts (Employment / 941 / quarters) from erc_recovery events. */
function ercActs(erc: any, fallbackForm: string): Act2848[] {
  const events = Array.isArray(erc?.events) ? erc.events : [];
  const quarters = events
    .map((e: any) => String(e.tax_quarter || '').replace('-Q', 'Q'))
    .filter(Boolean)
    .sort();
  const form = events[0]?.form_type || (fallbackForm && /^94/.test(fallbackForm) ? fallbackForm : '941');
  const years = quarters.length
    ? (quarters.length === 1 ? quarters[0] : `${quarters[0]}-${quarters[quarters.length - 1]}`)
    : '';
  return [{
    description: 'Employment (ERC refund reissue — correct address of record + secure reissuance)',
    form,
    years,
  }];
}

export async function GET(_request: NextRequest, { params }: { params: { token: string } }) {
  try {
    const entityId = verifyFilingIntakeToken(params.token);
    if (!entityId) return NextResponse.json({ error: 'This link isn’t valid.' }, { status: 401 });

    const admin = createAdminClient();
    const { data: entity } = await admin.from('request_entities')
      .select('id, entity_name, tid, tid_kind, form_type, address, city, state, zip_code, gross_receipts')
      .eq('id', entityId).single() as { data: any };
    if (!entity) return NextResponse.json({ error: 'Entity not found.' }, { status: 404 });

    const erc = entity.gross_receipts?.erc_recovery || {};
    const entityCityStateZip = [
      [entity.city, entity.state].filter(Boolean).join(', '),
      entity.zip_code,
    ].filter(Boolean).join(' ').trim();
    const entityAddress = [entity.address, entityCityStateZip].filter(Boolean).join(', ');
    // Prefer the corrected mailing address (what goes on record) if we have it.
    const taxpayerAddress = formatMailing(erc.new_mailing_address, entityAddress);

    const pdfBuffer = await generate2848PDF({
      taxpayer: {
        name: entity.entity_name || '',
        address: taxpayerAddress,
        tin: entity.tid || '',
        tinKind: normalizeTinKind(entity.tid_kind),
      },
      acts: ercActs(erc, entity.form_type),
    });

    const safeName = (entity.entity_name || 'entity').replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 40);
    return new NextResponse(new Uint8Array(pdfBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="Form-2848-${safeName}.pdf"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err: any) {
    console.error('[public/2848] error:', err?.message || err);
    return NextResponse.json({ error: 'Could not generate the form. Please try again.' }, { status: 500 });
  }
}
