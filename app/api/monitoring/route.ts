/**
 * Monitoring Subscription API
 * GET  — List monitoring subscriptions for a request or entity
 * POST — Enroll entity in monitoring
 * PATCH — Update monitoring (pause/resume/cancel/change frequency/set dates)
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';

const ENROLLMENT_FEE = 19.99;
const PER_PULL_FEE = 39.99;

function computeNextPullDate(frequency: string, customDays?: number | null, fromDate?: Date): string {
  const base = fromDate || new Date();
  const next = new Date(base);

  switch (frequency) {
    case 'weekly':
      next.setDate(next.getDate() + 7);
      break;
    case 'monthly':
      next.setMonth(next.getMonth() + 1);
      break;
    case 'quarterly':
      next.setMonth(next.getMonth() + 3);
      break;
    case 'custom':
      next.setDate(next.getDate() + (customDays || 30));
      break;
    default:
      next.setMonth(next.getMonth() + 1);
  }

  return next.toISOString().split('T')[0];
}

export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const { data: profile } = await supabase
      .from('profiles')
      .select('role, client_id')
      .eq('id', user.id)
      .single();

    if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 });

    const url = new URL(request.url);
    const requestId = url.searchParams.get('requestId');
    const entityId = url.searchParams.get('entityId');

    const adminSupabase = createAdminClient();

    // Build filters
    const filters: Record<string, string> = {};
    if (entityId) filters.entity_id = entityId;
    else if (requestId) filters.request_id = requestId;
    if (profile.role !== 'admin' && profile.client_id) filters.client_id = profile.client_id;

    let q = adminSupabase.from('entity_monitoring' as any).select('*');
    for (const [key, val] of Object.entries(filters)) {
      q = q.eq(key, val);
    }
    const { data: subscriptions, error } = await q.order('created_at', { ascending: false }) as { data: any[] | null; error: any };

    if (error) {
      console.error('Error fetching monitoring subscriptions:', error);
      return NextResponse.json({ error: 'Failed to fetch subscriptions' }, { status: 500 });
    }

    return NextResponse.json({ subscriptions: subscriptions || [] });
  } catch (error) {
    console.error('Monitoring GET error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const { data: profile } = await supabase
      .from('profiles')
      .select('role, client_id')
      .eq('id', user.id)
      .single();

    if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 });

    const body = await request.json();
    const { entityId, requestId, frequency, customIntervalDays, nextPullDate, expiresAt } = body;

    if (!entityId || !requestId) {
      return NextResponse.json({ error: 'entityId and requestId required' }, { status: 400 });
    }

    if (!['weekly', 'monthly', 'quarterly', 'custom'].includes(frequency)) {
      return NextResponse.json({ error: 'Invalid frequency' }, { status: 400 });
    }

    if (frequency === 'custom' && (!customIntervalDays || customIntervalDays < 1)) {
      return NextResponse.json({ error: 'customIntervalDays required for custom frequency' }, { status: 400 });
    }

    const adminSupabase = createAdminClient();

    // Verify entity exists and belongs to user's client
    const { data: entity } = await adminSupabase
      .from('request_entities')
      .select('id, entity_name, request_id, status')
      .eq('id', entityId)
      .single();

    if (!entity) {
      return NextResponse.json({ error: 'Entity not found' }, { status: 404 });
    }

    // Get request to verify client access
    const { data: req } = await adminSupabase
      .from('requests')
      .select('id, client_id')
      .eq('id', requestId)
      .single();

    if (!req) {
      return NextResponse.json({ error: 'Request not found' }, { status: 404 });
    }

    if (profile.role !== 'admin' && profile.client_id !== req.client_id) {
      return NextResponse.json({ error: 'Not authorized for this client' }, { status: 403 });
    }

    // Check if entity already has active monitoring
    const { data: existing } = await adminSupabase
      .from('entity_monitoring' as any)
      .select('id, status')
      .eq('entity_id', entityId)
      .in('status', ['active', 'paused'])
      .single() as { data: any; error: any };

    if (existing) {
      return NextResponse.json({
        error: 'Entity already has active monitoring',
        existingId: existing.id,
        existingStatus: existing.status,
      }, { status: 409 });
    }

    // Compute next pull date
    const computedNextPull = nextPullDate || computeNextPullDate(frequency, customIntervalDays);

    const { data: subscription, error: insertError } = await adminSupabase
      .from('entity_monitoring' as any)
      .insert({
        entity_id: entityId,
        request_id: requestId,
        client_id: req.client_id,
        enrolled_by: user.id,
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
      console.error('Failed to create monitoring subscription:', insertError);
      return NextResponse.json({ error: 'Failed to create subscription', details: insertError.message }, { status: 500 });
    }

    await logAuditFromRequest(adminSupabase, request, {
      action: 'settings_changed',
      userId: user.id,
      userEmail: user.email || '',
      resourceType: 'request_entity',
      resourceId: entityId,
      details: {
        monitoring_enrolled: true,
        frequency,
        next_pull_date: computedNextPull,
        enrollment_fee: ENROLLMENT_FEE,
        entity_name: entity.entity_name,
      },
    });

    return NextResponse.json({ success: true, subscription });
  } catch (error) {
    console.error('Monitoring POST error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const { data: profile } = await supabase
      .from('profiles')
      .select('role, client_id')
      .eq('id', user.id)
      .single();

    if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 });

    const body = await request.json();
    const { subscriptionId, action, frequency, customIntervalDays, nextPullDate, expiresAt } = body;

    if (!subscriptionId) {
      return NextResponse.json({ error: 'subscriptionId required' }, { status: 400 });
    }

    const adminSupabase = createAdminClient();

    // Fetch the subscription
    const { data: sub } = await adminSupabase
      .from('entity_monitoring' as any)
      .select('*')
      .eq('id', subscriptionId)
      .single() as { data: any; error: any };

    if (!sub) {
      return NextResponse.json({ error: 'Subscription not found' }, { status: 404 });
    }

    if (profile.role !== 'admin' && profile.client_id !== sub.client_id) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const updateData: Record<string, unknown> = {};

    switch (action) {
      case 'pause':
        if (sub.status !== 'active') {
          return NextResponse.json({ error: 'Can only pause active subscriptions' }, { status: 400 });
        }
        updateData.status = 'paused';
        break;

      case 'resume':
        if (sub.status !== 'paused') {
          return NextResponse.json({ error: 'Can only resume paused subscriptions' }, { status: 400 });
        }
        updateData.status = 'active';
        // Recalculate next pull if it's in the past
        const now = new Date();
        const existingNext = new Date(sub.next_pull_date);
        if (existingNext < now) {
          updateData.next_pull_date = computeNextPullDate(
            sub.frequency,
            sub.custom_interval_days
          );
        }
        break;

      case 'cancel':
        if (['cancelled', 'expired'].includes(sub.status)) {
          return NextResponse.json({ error: 'Already cancelled/expired' }, { status: 400 });
        }
        updateData.status = 'cancelled';
        updateData.cancelled_at = new Date().toISOString();
        break;

      case 'update':
        // Update frequency, dates, etc.
        if (frequency && ['weekly', 'monthly', 'quarterly', 'custom'].includes(frequency)) {
          updateData.frequency = frequency;
          if (frequency === 'custom') {
            updateData.custom_interval_days = customIntervalDays || 30;
          } else {
            updateData.custom_interval_days = null;
          }
          // Recalculate next pull date based on new frequency
          updateData.next_pull_date = nextPullDate || computeNextPullDate(frequency, customIntervalDays);
        }
        if (nextPullDate) {
          updateData.next_pull_date = nextPullDate;
        }
        if (expiresAt !== undefined) {
          updateData.expires_at = expiresAt;
        }
        break;

      default:
        return NextResponse.json({ error: 'Invalid action. Use: pause, resume, cancel, update' }, { status: 400 });
    }

    const { data: updated, error: updateError } = await adminSupabase
      .from('entity_monitoring' as any)
      .update(updateData)
      .eq('id', subscriptionId)
      .select()
      .single() as { data: any; error: any };

    if (updateError) {
      console.error('Failed to update monitoring:', updateError);
      return NextResponse.json({ error: 'Update failed', details: updateError.message }, { status: 500 });
    }

    await logAuditFromRequest(adminSupabase, request, {
      action: 'settings_changed',
      userId: user.id,
      userEmail: user.email || '',
      resourceType: 'request_entity',
      resourceId: sub.entity_id,
      details: {
        monitoring_action: action,
        subscription_id: subscriptionId,
        changes: updateData,
      },
    });

    return NextResponse.json({ success: true, subscription: updated });
  } catch (error) {
    console.error('Monitoring PATCH error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
