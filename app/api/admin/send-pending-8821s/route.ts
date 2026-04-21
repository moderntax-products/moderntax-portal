/**
 * Admin: re-fire 8821 signature requests on a specific request.
 *
 * POST /api/admin/send-pending-8821s?requestId=<uuid>
 *
 * For every entity on the given request that has:
 *   • signer_email populated
 *   • no signature_id yet
 *   • not already completed
 *   • form_type != 'W2_INCOME'
 * generate + send an 8821 via Dropbox Sign and update the entity with
 * signature_id + status='8821_sent'.
 *
 * This is the recovery path for requests that were created before the
 * email-body signer parser existed (or where the CSV came in without an
 * email column and the admin had to backfill signer_email manually).
 *
 * Auth: admin session OR CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { sendSignatureRequest } from '@/lib/dropbox-sign';
import { logAuditFromRequest } from '@/lib/audit';

export async function POST(request: NextRequest) {
  try {
    // Auth gate
    const authHeader = request.headers.get('authorization');
    const isCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
    let userId: string | undefined;
    let userEmail: string | undefined;
    if (!isCron) {
      const cookieStore = await cookies();
      const supabase = createServerRouteClient(cookieStore);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
      const admin = createAdminClient();
      const { data: profile } = await admin
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .single();
      if (!profile || (profile as any).role !== 'admin') {
        return NextResponse.json({ error: 'Admin only' }, { status: 403 });
      }
      userId = user.id;
      userEmail = user.email;
    }

    const admin = createAdminClient();
    const url = new URL(request.url);
    const requestId = url.searchParams.get('requestId');
    const entityId = url.searchParams.get('entityId');
    const scope = url.searchParams.get('scope');             // 'all' → every pending entity across every client
    const clientId = url.searchParams.get('clientId');       // optional narrower scope
    const dryRun = url.searchParams.get('dryRun') === '1';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 500);

    // Load the entity set to work on — callers pick one of three modes:
    //   (a) single entity          → ?entityId=...
    //   (b) single request         → ?requestId=...
    //   (c) every pending globally → ?scope=all  (optionally ?clientId=... to narrow)
    let entities: any[] | null = null;
    if (entityId) {
      const { data } = await admin.from('request_entities').select('*').eq('id', entityId) as { data: any[] | null; error: any };
      entities = data;
    } else if (requestId) {
      const { data } = await admin.from('request_entities').select('*').eq('request_id', requestId) as { data: any[] | null; error: any };
      entities = data;
    } else if (scope === 'all') {
      // Pre-filter at the DB so we only touch eligible rows: signer_email set,
      // no signature_id yet, not completed/cancelled, not W2.
      let q = admin
        .from('request_entities')
        .select('*, requests!inner(client_id)')
        .not('signer_email', 'is', null)
        .neq('signer_email', '')
        .is('signature_id', null)
        .not('status', 'in', '(completed,cancelled,failed)')
        .neq('form_type', 'W2_INCOME')
        .limit(limit);
      if (clientId) q = q.eq('requests.client_id', clientId);
      const { data } = await q as { data: any[] | null; error: any };
      entities = data;
    } else {
      return NextResponse.json(
        { error: 'Must pass one of: entityId, requestId, or scope=all (with optional clientId).' },
        { status: 400 },
      );
    }

    if (!entities || entities.length === 0) {
      return NextResponse.json({
        success: true,
        dry_run: dryRun,
        counts: {},
        details: [],
        message: 'No matching entities.',
      });
    }

    const report: Array<{ entityId: string; entityName: string; result: string; error?: string; signatureId?: string }> = [];

    for (const e of entities) {
      // Skip reasons mirror the CSV-upload auto-send logic in lib/*
      if (e.signature_id) { report.push({ entityId: e.id, entityName: e.entity_name, result: 'skip_already_has_signature' }); continue; }
      if (e.status === 'completed') { report.push({ entityId: e.id, entityName: e.entity_name, result: 'skip_already_completed' }); continue; }
      if (e.form_type === 'W2_INCOME') { report.push({ entityId: e.id, entityName: e.entity_name, result: 'skip_w2_income' }); continue; }
      if (!e.signer_email) { report.push({ entityId: e.id, entityName: e.entity_name, result: 'skip_no_signer_email' }); continue; }

      if (dryRun) {
        report.push({ entityId: e.id, entityName: e.entity_name, result: 'would_send' });
        continue;
      }

      try {
        const { signatureRequestId } = await sendSignatureRequest(e, e.signer_email);
        await admin
          .from('request_entities')
          .update({ signature_id: signatureRequestId, status: '8821_sent' })
          .eq('id', e.id);
        report.push({ entityId: e.id, entityName: e.entity_name, result: 'sent', signatureId: signatureRequestId });

        try {
          await logAuditFromRequest(admin, request, {
            action: 'file_uploaded',
            userId: userId || 'system',
            userEmail: userEmail || '',
            resourceType: 'request_entity',
            resourceId: e.id,
            details: {
              action: '8821_sent_via_admin_retrigger',
              entity_name: e.entity_name,
              signer_email: e.signer_email,
              signature_id: signatureRequestId,
              request_id: requestId,
            },
          });
        } catch { /* audit best-effort */ }
      } catch (err: any) {
        const msg = err?.body?.error?.errorMsg || err?.message || String(err);
        report.push({ entityId: e.id, entityName: e.entity_name, result: 'send_failed', error: msg });
      }
    }

    const counts = report.reduce<Record<string, number>>((acc, r) => {
      acc[r.result] = (acc[r.result] || 0) + 1;
      return acc;
    }, {});

    return NextResponse.json({
      success: true,
      request_id: requestId,
      dry_run: dryRun,
      counts,
      details: report,
    });
  } catch (error) {
    console.error('send-pending-8821s error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}

/**
 * GET /api/admin/send-pending-8821s
 *   Returns the count of entities that WOULD be fired if POST ?scope=all ran.
 *   Optional ?clientId=... narrows to one client.
 *
 * Used by the admin dashboard to render a "Fire all pending 8821s (N)" button
 * with a live count. No mutations.
 */
export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization');
    const isCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
    if (!isCron) {
      const cookieStore = await cookies();
      const supabase = createServerRouteClient(cookieStore);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
      const admin = createAdminClient();
      const { data: profile } = await admin.from('profiles').select('role').eq('id', user.id).single();
      if (!profile || (profile as any).role !== 'admin') {
        return NextResponse.json({ error: 'Admin only' }, { status: 403 });
      }
    }

    const admin = createAdminClient();
    const url = new URL(request.url);
    const clientId = url.searchParams.get('clientId');

    let q = admin
      .from('request_entities')
      .select('id, requests!inner(client_id)', { count: 'exact', head: true })
      .not('signer_email', 'is', null)
      .neq('signer_email', '')
      .is('signature_id', null)
      .not('status', 'in', '(completed,cancelled,failed)')
      .neq('form_type', 'W2_INCOME');
    if (clientId) q = q.eq('requests.client_id', clientId);

    const { count } = await q as { count: number | null };
    return NextResponse.json({ pending: count || 0 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
