/**
 * POST /api/public/2848-authorize/[token]
 *
 * No-login capture of a taxpayer's authorization to execute Form 2848 (POA) so
 * ModernTax can correct the address of record + secure reissuance of returned
 * ERC refund checks. Mirrors the established ERC-reissue intake pattern
 * (app/api/erc-reissue/intake) — a typed signature that must match the
 * authorized officer's name counts as the electronic signature, plus explicit
 * consent for ModernTax to represent the business before the IRS.
 *
 * Body: {
 *   officer: { name, title, signature_typed, signature_date },
 *   confirmed_mailing_address?: { address1, address2?, city, state, zip },
 *   consent_poa: boolean,      // authorize ModernTax as 2848 representative
 * }
 *
 * Records the authorization onto the entity's gross_receipts.erc_recovery
 * (authorization block + a merchant-visible stage_history entry). No IRS
 * submission happens here — an admin/expert executes the signed 2848.
 *
 * Auth: the signed token alone (verifyFilingIntakeToken). Matt 2026-07-01.
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

    const body = (await request.json().catch(() => null)) as any;
    const officer = body?.officer || {};
    const name = String(officer.name || '').trim();
    const title = String(officer.title || '').trim();
    const signature = String(officer.signature_typed || '').trim();
    const signatureDate = String(officer.signature_date || '').trim();

    if (!name || !title) return NextResponse.json({ error: 'Officer name and title are required.' }, { status: 400 });
    if (!body?.consent_poa) {
      return NextResponse.json({ error: 'Please authorize ModernTax to act as your Form 2848 representative.' }, { status: 400 });
    }
    // Typed-signature-must-match-name — same electronic-signature rule the IRS
    // reissue intake enforces.
    if (signature.toLowerCase() !== name.toLowerCase()) {
      return NextResponse.json({ error: 'Typed signature must exactly match the authorized officer’s full name.' }, { status: 400 });
    }

    const admin = createAdminClient();
    const { data: entity } = await admin.from('request_entities')
      .select('id, entity_name, gross_receipts').eq('id', entityId).single() as { data: any };
    if (!entity) return NextResponse.json({ error: 'Entity not found.' }, { status: 404 });

    const gr = entity.gross_receipts || {};
    const erc = gr.erc_recovery || {};
    const nowIso = new Date().toISOString();
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;

    // Idempotency — don't overwrite a prior signed authorization.
    if (erc.authorization?.signed_at) {
      return NextResponse.json({ ok: true, already: true });
    }

    const confirmed = body?.confirmed_mailing_address && typeof body.confirmed_mailing_address === 'object'
      ? body.confirmed_mailing_address : null;

    const authorization = {
      form: '2848',
      purpose: 'address_of_record_correction_and_erc_check_reissue',
      officer: { name, title },
      signature_typed: signature,
      signature_date: signatureDate || nowIso.slice(0, 10),
      consent_poa: true,
      signed_at: nowIso,
      signed_ip: ip,
      user_agent: request.headers.get('user-agent') || null,
    };

    const stageEntry = {
      at: nowIso,
      actor: 'taxpayer',
      stage: erc.current_stage || 'irs_contact_in_progress',
      merchant_visible_note: `Form 2848 authorization signed electronically by ${name} (${title}). ModernTax is now authorized to correct the address of record and request reissuance of both ERC refund checks directly with the IRS — no further action needed from you.`,
    };

    const newErc = {
      ...erc,
      authorization,
      ...(confirmed ? { new_mailing_address: confirmed } : {}),
      poa_2848_signed_at: nowIso,
      stage_history: [...(Array.isArray(erc.stage_history) ? erc.stage_history : []), stageEntry],
    };

    const { error: upErr } = await (admin.from('request_entities') as any)
      .update({ gross_receipts: { ...gr, erc_recovery: newErc } }).eq('id', entityId);
    if (upErr) {
      console.error('[public/2848-authorize] update failed:', upErr.message);
      return NextResponse.json({ error: 'Could not record your authorization. Please try again.' }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[public/2848-authorize] error:', err?.message || err);
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 });
  }
}
