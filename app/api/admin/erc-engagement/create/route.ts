/**
 * Admin: create a new ERC recovery engagement.
 *
 * POST /api/admin/erc-engagement/create
 *   Body: {
 *     entity_id: string,
 *     token?: string,            // optional slug; auto-generated from entity name if absent
 *     events: [{
 *       tax_quarter: string,     // e.g., "2021-Q3"
 *       period_ending: string,   // "09-30-2021" (mm-dd-yyyy)
 *       form_type?: string,      // default '941'
 *       issued_on: string,       // "08-29-2022"
 *       amount: number,          // dollars
 *       status?: 'undelivered' | 'delivered',
 *       returned_on?: string,    // same as issued_on for same-day TC 740
 *     }, ...],
 *     invoice?: {                // optional Mercury invoice link
 *       mercury_invoice_number: string,
 *       amount: number,
 *       pay_url: string,
 *     },
 *     kickoff_email?: {          // optional: send the kickoff email immediately
 *       to_email: string,
 *       to_name: string,
 *     },
 *   }
 *
 * Returns: { token, entity_id, tracking_url, kickoff_email_sent }
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import { sendErcIntakeKickoff } from '@/lib/sendgrid';
import { parseJsonBodyOrRespond } from '@/lib/request-body';

export const runtime = 'nodejs';

interface EventInput {
  tax_quarter: string;
  period_ending: string;
  form_type?: string;
  issued_on: string;
  amount: number;
  status?: 'undelivered' | 'delivered';
  returned_on?: string;
}

function slugify(s: string): string {
  return s.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = createServerRouteClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { data: profile } = await supabase
    .from('profiles').select('role').eq('id', user.id).single() as { data: { role: string } | null };
  if (profile?.role !== 'admin') return NextResponse.json({ error: 'Admin only' }, { status: 403 });

  const parsed = await parseJsonBodyOrRespond<any>(request, 64 * 1024);
  if (parsed instanceof NextResponse) return parsed;

  // Validate inputs
  const entityId: string = parsed.entity_id || '';
  if (!entityId) return NextResponse.json({ error: 'entity_id required' }, { status: 400 });

  const events: EventInput[] = Array.isArray(parsed.events) ? parsed.events : [];
  if (events.length === 0) return NextResponse.json({ error: 'At least one event/quarter required' }, { status: 400 });
  for (const e of events) {
    if (!e.tax_quarter || !e.issued_on || typeof e.amount !== 'number' || !Number.isFinite(e.amount)) {
      return NextResponse.json({ error: 'Each event needs tax_quarter, issued_on, and numeric amount' }, { status: 400 });
    }
  }

  const admin = createAdminClient();
  const { data: entity, error: entErr } = await admin
    .from('request_entities')
    .select('id, entity_name, gross_receipts')
    .eq('id', entityId)
    .maybeSingle() as { data: any; error: any };
  if (entErr || !entity) return NextResponse.json({ error: 'Entity not found' }, { status: 404 });

  // Token: explicit override OR slug(entity_name) + dedup suffix
  let token: string = (parsed.token || '').toString().trim() || `${slugify(entity.entity_name)}-recovery`;
  // Check for collision; if taken, append short random suffix
  {
    const { data: collision } = await admin
      .from('request_entities')
      .select('id')
      .eq('gross_receipts->>erc_recovery_token', token)
      .neq('id', entityId)
      .maybeSingle();
    if (collision) {
      token = `${token}-${Math.random().toString(36).slice(2, 6)}`;
    }
  }

  // Build totals from events
  const normalizedEvents = events.map(e => ({
    tax_quarter: e.tax_quarter,
    period_ending: e.period_ending,
    form_type: e.form_type || '941',
    issued_on: e.issued_on,
    amount: Number(e.amount),
    status: e.status || 'undelivered',
    returned_on: e.returned_on || (e.status === 'undelivered' ? e.issued_on : null),
  }));
  const totalIssued = normalizedEvents.reduce((s, e) => s + e.amount, 0);
  const totalUndelivered = normalizedEvents.filter(e => e.status === 'undelivered').reduce((s, e) => s + e.amount, 0);
  const totalDelivered = totalIssued - totalUndelivered;
  const totalRecoverable = totalUndelivered;

  const now = new Date().toISOString();
  const recoveryData = {
    erc_recovery_token: token,
    erc_recovery: {
      engagement_created_at: now,
      total_recoverable: totalRecoverable,
      total_issued: totalIssued,
      total_delivered: totalDelivered,
      total_undelivered: totalUndelivered,
      events: normalizedEvents,
      current_stage: 'engagement_created',
      stage_history: [{
        stage: 'engagement_created',
        at: now,
        actor: user.email || user.id,
        merchant_visible_note: 'Engagement created by ModernTax — recoverable amount confirmed from IRS account transcripts.',
        internal_note: `Created via /admin/erc-engagements/new by ${user.email || 'admin'}`,
      }],
      ...(parsed.invoice ? {
        invoice: {
          mercury_invoice_number: parsed.invoice.mercury_invoice_number,
          amount: Number(parsed.invoice.amount),
          pay_url: parsed.invoice.pay_url,
        },
      } : {}),
    },
  };

  const merged = { ...(entity.gross_receipts || {}), ...recoveryData };
  const { error: upErr } = await admin
    .from('request_entities')
    .update({ gross_receipts: merged })
    .eq('id', entityId);
  if (upErr) {
    return NextResponse.json({ error: 'Failed to save recovery state', admin_hint: upErr.message }, { status: 500 });
  }

  // Optional kickoff email
  let kickoffEmailSent = false;
  if (parsed.kickoff_email?.to_email) {
    const trackingUrl = `https://portal.moderntax.io/erc-status/${token}`;
    const intakeUrl = trackingUrl; // MVP — intake form is the tracking page for now
    try {
      await sendErcIntakeKickoff({
        toEmail: parsed.kickoff_email.to_email,
        toName: parsed.kickoff_email.to_name || entity.entity_name,
        entityName: entity.entity_name,
        totalRecoverable,
        intakeUrl,
        trackingUrl,
        quarters: normalizedEvents.map(e => ({
          taxQuarter: e.tax_quarter,
          amount: e.amount,
          issuedDate: e.issued_on,
        })),
      });
      kickoffEmailSent = true;
    } catch (emailErr) {
      console.warn('[erc-engagement/create] kickoff email failed (non-fatal):', emailErr);
    }
  }

  await logAuditFromRequest(admin, request, {
    action: 'admin_access',
    userId: user.id,
    userEmail: user.email || '',
    resourceType: 'request_entity',
    resourceId: entityId,
    details: {
      kind: 'erc_engagement_created',
      entity_name: entity.entity_name,
      token,
      total_recoverable: totalRecoverable,
      event_count: normalizedEvents.length,
      kickoff_email_sent: kickoffEmailSent,
    },
  });

  return NextResponse.json({
    success: true,
    token,
    entity_id: entityId,
    tracking_url: `https://portal.moderntax.io/erc-status/${token}`,
    admin_url: `https://portal.moderntax.io/admin/erc-engagements/${token}`,
    total_recoverable: totalRecoverable,
    kickoff_email_sent: kickoffEmailSent,
  });
}
