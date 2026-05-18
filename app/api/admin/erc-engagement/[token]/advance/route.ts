/**
 * Admin: advance an ERC recovery engagement to a new stage.
 *
 * POST /api/admin/erc-engagement/[token]/advance
 *   Body: {
 *     to_stage: string,           // one of the 9 stages in STAGES[]
 *     merchant_note?: string,     // optional per-transition note shown to merchant
 *     internal_note?: string,     // optional internal-only note (audit trail)
 *     new_mailing_address?: {     // optional address capture (when merchant replies with it)
 *       address1: string;
 *       address2?: string;
 *       city: string;
 *       state: string;
 *       zip: string;
 *     },
 *     merchant_email?: string,    // merchant address to notify (defaults to entity.signer_email)
 *     merchant_name?: string,     // for email salutation
 *     suppress_email?: boolean,   // for back-fill / silent updates
 *   }
 *
 * What it does:
 *   1. Loads the entity by gross_receipts.erc_recovery_token (or by entity_id if token is a UUID)
 *   2. Appends a stage_history entry with the new stage + merchant note + actor + timestamp
 *   3. Updates current_stage
 *   4. Optionally stores new_mailing_address on the recovery JSONB
 *   5. Fires sendErcStageUpdate to the merchant (unless suppress_email=true)
 *   6. Audit logs
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import { sendErcStageUpdate } from '@/lib/sendgrid';
import { parseJsonBodyOrRespond } from '@/lib/request-body';

export const runtime = 'nodejs';

// Mirrors STAGES in app/erc-status/[token]/page.tsx — keep in sync.
const STAGE_DEFS: { key: string; label: string; merchantCopy: string }[] = [
  { key: 'engagement_created',        label: 'Engagement created',           merchantCopy: 'We confirmed the recoverable amount and sent your invoice + status page.' },
  { key: 'awaiting_payment',          label: 'Awaiting payment',             merchantCopy: 'Once the Mercury invoice clears, we kick off the IRS call.' },
  { key: 'awaiting_intake',           label: 'Awaiting intake form',         merchantCopy: 'We need your new mailing address + Form 3911 signature before we call the IRS.' },
  { key: 'intake_complete',           label: 'Ready to file',                merchantCopy: 'All required info received — call to IRS scheduled.' },
  { key: 'irs_contact_in_progress',   label: 'On the line with IRS',         merchantCopy: 'Our expert is on the phone with the IRS Business & Specialty Tax Line.' },
  { key: 'trace_filed',               label: 'Refund trace filed',           merchantCopy: 'IRS has logged the trace request. Bureau of Fiscal Service verification begins.' },
  { key: 'irs_verifying',             label: 'IRS verifying',                merchantCopy: 'BFS confirming neither check was cashed before we get reissue authorization.' },
  { key: 'check_in_mail',             label: 'Replacement checks in mail',   merchantCopy: 'IRS issued replacement checks — should arrive in ~1 week.' },
  { key: 'check_received',            label: 'Check received',               merchantCopy: 'You confirmed receipt of both checks. Engagement complete!' },
];

export async function POST(
  request: NextRequest,
  { params }: { params: { token: string } },
) {
  const cookieStore = await cookies();
  const supabase = createServerRouteClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { data: profile } = await supabase
    .from('profiles').select('role').eq('id', user.id).single() as { data: { role: string } | null };
  if (profile?.role !== 'admin') return NextResponse.json({ error: 'Admin only' }, { status: 403 });

  const parsed = await parseJsonBodyOrRespond<any>(request, 32 * 1024);
  if (parsed instanceof NextResponse) return parsed;

  const toStage = parsed.to_stage;
  if (!STAGE_DEFS.find(s => s.key === toStage)) {
    return NextResponse.json({ error: `Unknown stage "${toStage}". Valid: ${STAGE_DEFS.map(s => s.key).join(', ')}` }, { status: 400 });
  }
  const stageDef = STAGE_DEFS.find(s => s.key === toStage)!;

  const admin = createAdminClient();

  // Resolve token → entity. Token can be either the recovery token
  // (gross_receipts.erc_recovery_token) or an entity UUID.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.token);
  const lookupQuery = isUuid
    ? admin.from('request_entities').select('id, entity_name, signer_email, gross_receipts, requests(submitter_email)').eq('id', params.token)
    : admin.from('request_entities').select('id, entity_name, signer_email, gross_receipts, requests(submitter_email)').eq('gross_receipts->>erc_recovery_token', params.token);

  const { data: entity, error: lookupErr } = await (lookupQuery as any).maybeSingle();
  if (lookupErr || !entity) {
    return NextResponse.json({ error: 'Engagement not found' }, { status: 404 });
  }
  const recovery = entity.gross_receipts?.erc_recovery || {};

  // Build the new stage_history entry
  const now = new Date().toISOString();
  const newHistoryEntry = {
    stage: toStage,
    at: now,
    actor: user.email || user.id,
    merchant_visible_note: parsed.merchant_note || stageDef.merchantCopy,
    internal_note: parsed.internal_note || null,
  };

  const updatedRecovery = {
    ...recovery,
    current_stage: toStage,
    stage_history: [...(Array.isArray(recovery.stage_history) ? recovery.stage_history : []), newHistoryEntry],
    ...(parsed.new_mailing_address ? { new_mailing_address: parsed.new_mailing_address } : {}),
  };

  const { error: updErr } = await admin
    .from('request_entities')
    .update({ gross_receipts: { ...entity.gross_receipts, erc_recovery: updatedRecovery } })
    .eq('id', entity.id);
  if (updErr) {
    return NextResponse.json({ error: 'Failed to update recovery state', admin_hint: updErr.message }, { status: 500 });
  }

  // Audit log
  await logAuditFromRequest(admin, request, {
    action: 'admin_access',
    userId: user.id,
    userEmail: user.email || '',
    resourceType: 'request_entity',
    resourceId: entity.id,
    details: {
      kind: 'erc_engagement_stage_advanced',
      entity_name: entity.entity_name,
      to_stage: toStage,
      merchant_note: parsed.merchant_note || null,
      internal_note: parsed.internal_note || null,
      address_captured: !!parsed.new_mailing_address,
    },
  });

  // Email merchant
  let emailFired = false;
  if (!parsed.suppress_email) {
    const recipientEmail = parsed.merchant_email || entity.signer_email || entity.requests?.submitter_email;
    if (recipientEmail) {
      const token = recovery.erc_recovery_token || entity.gross_receipts?.erc_recovery_token;
      const trackingUrl = `https://portal.moderntax.io/erc-status/${token}`;
      try {
        await sendErcStageUpdate({
          toEmail: recipientEmail,
          toName: parsed.merchant_name || null,
          entityName: entity.entity_name,
          stageLabel: stageDef.label,
          stageMerchantCopy: stageDef.merchantCopy,
          customNote: parsed.merchant_note || null,
          trackingUrl,
        });
        emailFired = true;
      } catch (emailErr) {
        console.warn('[erc-advance] email failed (non-fatal):', emailErr);
      }
    }
  }

  return NextResponse.json({
    success: true,
    entity_id: entity.id,
    to_stage: toStage,
    email_fired: emailFired,
    stage_history_count: updatedRecovery.stage_history.length,
  });
}
