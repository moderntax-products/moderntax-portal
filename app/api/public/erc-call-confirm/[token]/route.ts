/**
 * POST /api/public/erc-call-confirm/[token]
 *
 * No-login: the taxpayer confirms they called the IRS Business & Specialty line
 * to correct the address of record + request reissuance of the returned ERC
 * refund checks. Records it on the entity's gross_receipts.erc_recovery (a
 * merchant-visible stage_history entry + call_confirmed_at) so ModernTax can
 * track and follow up. Idempotent. Auth: the signed token alone.
 *
 * Matt 2026-07-01.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { verifyFilingIntakeToken } from '@/lib/intake-tokens';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: { token: string } }) {
  try {
    const entityId = verifyFilingIntakeToken(params.token);
    if (!entityId) return NextResponse.json({ error: 'This link isn’t valid.' }, { status: 401 });

    const admin = createAdminClient();
    const { data: entity } = await admin.from('request_entities')
      .select('id, gross_receipts').eq('id', entityId).single() as { data: any };
    if (!entity) return NextResponse.json({ error: 'Entity not found.' }, { status: 404 });

    const gr = entity.gross_receipts || {};
    const erc = gr.erc_recovery || {};
    if (erc.call_confirmed_at) return NextResponse.json({ ok: true, already: true });

    const nowIso = new Date().toISOString();
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
    const stageEntry = {
      at: nowIso,
      actor: 'taxpayer',
      stage: erc.current_stage || 'irs_contact_in_progress',
      merchant_visible_note: 'Taxpayer confirmed they called the IRS Business & Specialty line to correct the address of record and request reissuance of both returned ERC refund checks. Watching the account for the address update + reissue.',
    };
    const newErc = {
      ...erc,
      call_confirmed_at: nowIso,
      call_confirmed_ip: ip,
      stage_history: [...(Array.isArray(erc.stage_history) ? erc.stage_history : []), stageEntry],
    };

    const { error: upErr } = await (admin.from('request_entities') as any)
      .update({ gross_receipts: { ...gr, erc_recovery: newErc } }).eq('id', entityId);
    if (upErr) {
      console.error('[erc-call-confirm] update failed:', upErr.message);
      return NextResponse.json({ error: 'Could not record that. Please try again.' }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[erc-call-confirm] error:', err?.message || err);
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 });
  }
}
