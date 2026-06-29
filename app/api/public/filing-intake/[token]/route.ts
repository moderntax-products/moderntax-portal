/**
 * POST /api/public/filing-intake/[token]
 *
 * No-login filing-intake submission. The signed token authorizes writing intake
 * answers (and authorization) to exactly one entity — the taxpayer never logs
 * in. Mirrors the save logic of the authed /api/entity/filing-intake route.
 *
 * Body: { answers: object, authorize?: boolean }   (entityId comes from the token)
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { verifyFilingIntakeToken } from '@/lib/intake-tokens';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: { token: string } }) {
  const entityId = verifyFilingIntakeToken(params.token);
  if (!entityId) {
    // SOC 2 CC7.2 — log bad-token attempts (truncated) so enumeration is visible.
    try {
      const admin = createAdminClient();
      const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0]?.trim() || 'unknown';
      await (admin.from('audit_log' as any) as any).insert({
        user_email: null, action: 'filing_intake_bad_token', entity_type: 'request_entity', entity_id: null,
        details: { token_prefix: (params.token || '').slice(0, 6), user_agent: request.headers.get('user-agent') || null }, ip_address: ip,
      });
    } catch { /* best-effort */ }
    return NextResponse.json({ error: 'This link is no longer valid.' }, { status: 404 });
  }

  const body = (await request.json().catch(() => null)) as { answers?: any; authorize?: boolean } | null;
  if (!body?.answers) return NextResponse.json({ error: 'answers required' }, { status: 400 });

  const admin = createAdminClient();
  const { data: entity } = await admin.from('request_entities')
    .select('id, entity_name, signer_email, gross_receipts').eq('id', entityId).single() as { data: any };
  if (!entity) return NextResponse.json({ error: 'Entity not found' }, { status: 404 });

  const now = new Date().toISOString();
  const gr = entity.gross_receipts || {};
  const prior = gr.filing_intake || {};
  const filing_intake = {
    ...prior,
    answers: body.answers,
    updated_at: now,
    via: 'public_link',
    ...(body.authorize ? {
      authorized: true,
      authorized_at: prior.authorized_at || now,
      authorized_by: entity.signer_email || entity.entity_name || 'Taxpayer (link)',
    } : {}),
  };

  const { error } = await (admin.from('request_entities') as any)
    .update({ gross_receipts: { ...gr, filing_intake } }).eq('id', entityId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Notify admins the FIRST time intake is authorized (mirrors the authed route).
  if (body.authorize && !prior.authorized) {
    try {
      const { sendAdminMilestoneEmail } = await import('@/lib/sendgrid');
      const { data: admins } = await admin.from('profiles').select('email').eq('role', 'admin') as { data: { email: string }[] | null };
      const who = entity.entity_name;
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io';
      await sendAdminMilestoneEmail(
        (admins || []).map(a => a.email).filter(Boolean),
        `Filing intake authorized — ${who}`,
        [`<strong>${who}</strong> completed and <strong>authorized</strong> their filing intake via the no-login link.`,
         `Their answers are saved on the entity — you're clear to prepare the returns.`],
        { text: 'Open request', url: `${appUrl}/admin` },
      );
    } catch (e) { console.warn('[public filing-intake] admin notify failed:', e); }
  }

  return NextResponse.json({ success: true, authorized: !!filing_intake.authorized });
}
