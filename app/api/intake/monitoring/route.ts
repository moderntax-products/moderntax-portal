/**
 * Partner monitoring intake endpoint
 *
 * POST /api/intake/monitoring
 *
 * Enroll an entity in ongoing transcript monitoring. Mirrors the
 * cookie-auth /api/monitoring POST, but authenticated by `x-api-key`
 * and addressable by partner-friendly identifiers (request_token +
 * entity_name or entity_id) instead of internal UUIDs.
 *
 * Two key partner-only knobs:
 *   - frequency='annual' supported (Moxie's portfolio-management
 *     cadence). 'weekly' / 'monthly' / 'quarterly' / 'custom' also work.
 *   - skipInitialPull=true creates the subscription WITHOUT triggering
 *     an immediate expert pull. Use when enrolling a brand-new business
 *     that has no tax records yet — the cron sweep will fire on
 *     next_pull_date instead.
 *
 * Why this exists: Moxie demo asked for it. Their flow: at loan close,
 * call /api/intake/transcript to create the request + enroll in
 * monitoring with skipInitialPull. The first real pull happens 12 months
 * later when the borrower's annual return is due.
 *
 * Auth: x-api-key (hashed lookup, constant-time verified).
 *
 * Request body (JSON):
 *   {
 *     request_token:    string  (required)
 *     entity_name:      string  (one of these required)
 *     entity_id:        string
 *     frequency:        'weekly'|'monthly'|'quarterly'|'annual'|'custom'  (required)
 *     custom_interval_days: number  (required if frequency='custom')
 *     skip_initial_pull: boolean   (default: false)
 *     expires_at:       ISO date  (optional — auto-cancel after this)
 *     next_pull_date:   ISO date  (optional — overrides computed next pull)
 *   }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import { sha256Hex, safeEqual } from '@/lib/auth-util';
import { sendExpertAssignmentNotification } from '@/lib/sendgrid';
import { MONITORING_FREQUENCIES, computeNextPullDate, type MonitoringFrequency } from '@/app/api/monitoring/route';

export const runtime = 'nodejs';
export const maxDuration = 30;

const ENROLLMENT_FEE = 19.99;
const PER_PULL_FEE = 59.98;

export async function POST(request: NextRequest) {
  try {
    // --- Auth ---
    const apiKey = request.headers.get('x-api-key');
    if (!apiKey) {
      return NextResponse.json({ error: 'Missing x-api-key header' }, { status: 401 });
    }

    const supabase = createAdminClient();
    const presentedHash = sha256Hex(apiKey);

    const { data: client } = await supabase
      .from('clients')
      .select('id, name, api_key_hash')
      .eq('api_key_hash', presentedHash)
      .single() as { data: { id: string; name: string; api_key_hash: string } | null };

    if (!client || !safeEqual(client.api_key_hash, presentedHash)) {
      return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
    }

    // --- Parse body ---
    const body = await request.json().catch(() => null);
    if (!body) {
      return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
    }

    const {
      request_token: requestToken,
      entity_name: entityName,
      entity_id: entityIdInput,
      frequency,
      custom_interval_days: customIntervalDays,
      skip_initial_pull: skipInitialPull,
      expires_at: expiresAt,
      next_pull_date: nextPullDate,
    } = body;

    if (!requestToken || typeof requestToken !== 'string') {
      return NextResponse.json({ error: 'request_token is required' }, { status: 400 });
    }
    if (!entityName && !entityIdInput) {
      return NextResponse.json(
        { error: 'either entity_name or entity_id is required' },
        { status: 400 },
      );
    }
    if (!MONITORING_FREQUENCIES.includes(frequency as MonitoringFrequency)) {
      return NextResponse.json(
        { error: `frequency must be one of: ${MONITORING_FREQUENCIES.join(', ')}` },
        { status: 400 },
      );
    }
    if (frequency === 'custom' && (!customIntervalDays || customIntervalDays < 1)) {
      return NextResponse.json(
        { error: 'custom_interval_days required when frequency=custom' },
        { status: 400 },
      );
    }

    // --- Resolve request + entity, scoped to client ---
    const { data: req } = await supabase
      .from('requests')
      .select('id, client_id, external_request_token')
      .eq('external_request_token', requestToken)
      .eq('client_id', client.id)
      .maybeSingle() as { data: { id: string; client_id: string } | null };

    if (!req) {
      return NextResponse.json(
        { error: 'request_token not found for your account' },
        { status: 404 },
      );
    }

    let entity: any = null;
    if (entityIdInput) {
      const { data } = await supabase
        .from('request_entities')
        .select('id, entity_name, request_id, status')
        .eq('id', entityIdInput)
        .eq('request_id', req.id)
        .maybeSingle();
      entity = data;
    } else {
      const { data: candidates } = await supabase
        .from('request_entities')
        .select('id, entity_name, request_id, status')
        .eq('request_id', req.id)
        .ilike('entity_name', entityName) as { data: any[] | null };
      if (!candidates || candidates.length === 0) {
        // empty
      } else if (candidates.length > 1) {
        return NextResponse.json(
          {
            error: `multiple entities named "${entityName}" — pass entity_id`,
            entity_ids: candidates.map(c => c.id),
          },
          { status: 409 },
        );
      } else {
        entity = candidates[0];
      }
    }

    if (!entity) {
      return NextResponse.json({ error: 'entity not found in request' }, { status: 404 });
    }

    // --- Idempotency: don't create duplicate active monitoring ---
    const { data: existing } = await supabase
      .from('entity_monitoring' as any)
      .select('id, status, frequency, next_pull_date')
      .eq('entity_id', entity.id)
      .in('status', ['active', 'paused'])
      .maybeSingle() as { data: any };

    if (existing) {
      return NextResponse.json(
        {
          error: 'entity already has active monitoring',
          subscription: existing,
        },
        { status: 409 },
      );
    }

    // --- Insert subscription ---
    const computedNextPull = nextPullDate || computeNextPullDate(frequency, customIntervalDays);

    const { data: subscription, error: insertError } = await supabase
      .from('entity_monitoring' as any)
      .insert({
        entity_id: entity.id,
        request_id: req.id,
        client_id: req.client_id,
        enrolled_by: null, // partner — no portal user attribution
        frequency,
        custom_interval_days: frequency === 'custom' ? customIntervalDays : null,
        next_pull_date: computedNextPull,
        expires_at: expiresAt || null,
        status: 'active',
        enrollment_fee: ENROLLMENT_FEE,
        per_pull_fee: PER_PULL_FEE,
        total_billed: ENROLLMENT_FEE,
      })
      .select()
      .single() as { data: any; error: any };

    if (insertError) {
      console.error('[intake/monitoring] insert error', insertError);
      return NextResponse.json(
        { error: 'failed to create subscription', details: insertError.message },
        { status: 500 },
      );
    }

    // --- Optional immediate pull (skipped for portfolio-mgmt mode) ---
    let immediateAssignment: any = null;
    if (!skipInitialPull) {
      try {
        const { data: experts } = await supabase
          .from('profiles')
          .select('id, full_name, email')
          .eq('role', 'expert');

        if (experts && experts.length > 0) {
          const { data: assignmentCounts } = await supabase
            .from('expert_assignments')
            .select('expert_id')
            .in('status', ['assigned', 'in_progress']);

          const countByExpert = new Map<string, number>();
          experts.forEach((e: any) => countByExpert.set(e.id, 0));
          (assignmentCounts || []).forEach((a: any) => {
            countByExpert.set(a.expert_id, (countByExpert.get(a.expert_id) || 0) + 1);
          });

          const sorted = experts.sort(
            (a: any, b: any) => (countByExpert.get(a.id) || 0) - (countByExpert.get(b.id) || 0),
          );
          const expert = sorted[0] as any;

          const slaDeadline = new Date();
          slaDeadline.setHours(slaDeadline.getHours() + 48);

          // assigned_by is null because partner API enrollments aren't
          // attributed to a portal user. Cast to bypass the generated
          // type that doesn't reflect the column's nullability.
          const { data: assignment } = await (supabase
            .from('expert_assignments') as any)
            .insert({
              entity_id: entity.id,
              expert_id: expert.id,
              assigned_by: null,
              sla_deadline: slaDeadline.toISOString(),
              status: 'assigned',
            })
            .select()
            .single();

          if (assignment) {
            immediateAssignment = assignment;
            await supabase
              .from('request_entities')
              .update({ status: 'irs_queue' })
              .eq('id', entity.id);

            const today = new Date().toISOString().split('T')[0];
            await supabase
              .from('entity_monitoring' as any)
              .update({
                last_pull_date: today,
                total_pulls_completed: 1,
                total_billed: ENROLLMENT_FEE + PER_PULL_FEE,
                pull_history: [{
                  date: today,
                  status: 'queued',
                  transcript_count: 0,
                  assigned_to: expert.full_name || expert.email,
                  type: 'initial_enrollment_partner_api',
                }],
              })
              .eq('id', subscription.id);

            try {
              await sendExpertAssignmentNotification(
                expert.email,
                [entity.entity_name + ' (Monitoring — Initial Pull, Partner API)'],
                1,
              );
            } catch (emailErr) {
              console.error('[intake/monitoring] expert email failed', emailErr);
            }
          }
        }
      } catch (pullErr) {
        // Non-fatal: subscription is created, the cron will catch up.
        console.error('[intake/monitoring] immediate pull failed', pullErr);
      }
    }

    await logAuditFromRequest(supabase, request, {
      action: 'partner_monitoring_enrolled',
      resourceType: 'request_entity',
      resourceId: entity.id,
      details: {
        client_name: client.name,
        request_token: requestToken,
        entity_name: entity.entity_name,
        frequency,
        skip_initial_pull: !!skipInitialPull,
        next_pull_date: computedNextPull,
      },
    });

    return NextResponse.json({
      success: true,
      subscription: {
        id: subscription.id,
        entity_id: entity.id,
        entity_name: entity.entity_name,
        frequency,
        custom_interval_days: subscription.custom_interval_days,
        next_pull_date: computedNextPull,
        expires_at: subscription.expires_at,
        status: subscription.status,
      },
      immediate_pull: immediateAssignment
        ? {
            assignment_id: immediateAssignment.id,
            sla_deadline: immediateAssignment.sla_deadline,
            status: 'expert_assigned',
          }
        : null,
      skipped_initial_pull: !!skipInitialPull,
    });
  } catch (err) {
    console.error('[intake/monitoring] unexpected error', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
