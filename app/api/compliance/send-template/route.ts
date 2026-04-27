/**
 * Send a compliance-resolution template email to a borrower.
 *
 * POST /api/compliance/send-template
 *   Body: {
 *     entity_id: string,
 *     template_id: string,
 *     to_email?: string,             // optional override; defaults to entity.signer_email
 *     custom_message?: string,       // optional pre-template lines from the sender
 *   }
 *
 * Auth: caller must be a manager or processor on the same client_id as
 * the entity, OR an admin. The template renders with the entity's flag
 * details and ships via SendGrid. Logs the send to compliance_drip
 * (existing table) for funnel tracking + audit history.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import { TEMPLATES, renderTemplate, markdownToHtml } from '@/lib/compliance-templates';
import sgMail from '@sendgrid/mail';

const sendGridApiKey = process.env.SENDGRID_API_KEY;
const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'matt@moderntax.io';
if (sendGridApiKey) sgMail.setApiKey(sendGridApiKey);

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = createServerRouteClient(cookieStore);

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, client_id, full_name, email')
    .eq('id', user.id)
    .single() as { data: { role: string; client_id: string | null; full_name: string | null; email: string } | null; error: any };
  if (!profile || !['admin', 'manager', 'processor'].includes(profile.role)) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }

  const body = await request.json().catch(() => ({} as any));
  const entityId: string | undefined = body.entity_id;
  const templateId: string | undefined = body.template_id;
  const overrideTo: string | undefined = body.to_email;
  const customPreface: string | undefined = body.custom_message;

  if (!entityId || !templateId) {
    return NextResponse.json({ error: 'entity_id and template_id required' }, { status: 400 });
  }

  const template = TEMPLATES.find(t => t.id === templateId);
  if (!template) {
    return NextResponse.json({ error: 'Template not found', valid: TEMPLATES.map(t => t.id) }, { status: 400 });
  }

  const admin = createAdminClient();

  // Look up the entity + flag details + ownership
  const { data: entity, error: lookupErr } = await admin
    .from('request_entities')
    .select('id, entity_name, signer_email, signer_first_name, gross_receipts, request_id, requests(client_id, loan_number)')
    .eq('id', entityId)
    .single() as { data: any; error: any };
  if (lookupErr || !entity) return NextResponse.json({ error: 'Entity not found' }, { status: 404 });

  // Authorization: same client_id as the entity (admins always pass).
  if (profile.role !== 'admin' && entity.requests?.client_id !== profile.client_id) {
    return NextResponse.json({ error: 'Not authorized for this entity' }, { status: 403 });
  }

  const toEmail = overrideTo || entity.signer_email;
  if (!toEmail) {
    return NextResponse.json({ error: 'No email address on file for this entity. Provide to_email override.' }, { status: 400 });
  }

  // Pull the most relevant flag message from gross_receipts JSONB.
  const flags: { type: string; message: string; severity: string }[] = [];
  for (const v of Object.values(entity.gross_receipts || {})) {
    if (v && typeof v === 'object' && Array.isArray((v as any).flags)) {
      flags.push(...(v as any).flags);
    }
  }
  // Find the first flag matching this template's flag_types — that's what we mention.
  const matchingFlag = flags.find(f => template.flag_types.includes(f.type));
  const flagMessage = matchingFlag?.message || 'See attached IRS transcript for details.';

  const rendered = renderTemplate(template, {
    borrower_name: entity.signer_first_name || undefined,
    entity_name: entity.entity_name,
    flag_message: flagMessage,
  });

  const bodyHtml = (customPreface ? `<p>${customPreface.replace(/\n/g, '<br>')}</p>` : '')
    + markdownToHtml(rendered.body_markdown);

  // Send the email
  if (!sendGridApiKey) {
    return NextResponse.json({ error: 'SENDGRID_API_KEY not configured' }, { status: 500 });
  }
  try {
    await sgMail.send({
      to: toEmail,
      from: fromEmail,
      replyTo: profile.email || 'matt@moderntax.io',
      subject: rendered.subject,
      html: bodyHtml,
    });
  } catch (err) {
    console.error('[compliance/send-template] sendgrid error:', err);
    return NextResponse.json({ error: 'Failed to send email' }, { status: 502 });
  }

  // Log to compliance_drip (existing table) for funnel tracking. Best-effort.
  try {
    await (admin.from('compliance_drip' as any) as any).upsert({
      entity_id: entityId,
      borrower_email: toEmail,
      template_id: templateId,
      template_subject: rendered.subject,
      sent_by: user.id,
      sent_by_email: profile.email,
      email_0_sent_at: new Date().toISOString(),
    }, { onConflict: 'entity_id,template_id' });
  } catch (logErr) {
    console.warn('[compliance/send-template] drip log failed (non-fatal):', logErr);
  }

  await logAuditFromRequest(admin, request, {
    action: 'request_created',  // closest existing AuditAction; could add 'compliance_outreach_sent'
    userId: user.id,
    userEmail: profile.email || '',
    resourceType: 'entity',
    resourceId: entityId,
    details: {
      compliance_outreach: true,
      template_id: templateId,
      to_email: toEmail,
      entity_name: entity.entity_name,
      flag_message: flagMessage,
    },
  });

  return NextResponse.json({
    success: true,
    template_id: templateId,
    to_email: toEmail,
    subject: rendered.subject,
  });
}
