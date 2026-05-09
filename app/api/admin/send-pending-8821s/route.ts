/**
 * Re-fire 8821 signature requests for entities already in the system.
 *
 * POST /api/admin/send-pending-8821s
 *   ?requestId=<uuid>             — every eligible entity on one request
 *   ?entityId=<uuid>              — single entity
 *   ?scope=all                    — every eligible entity, ALL CLIENTS (admin only)
 *   ?scope=all&clientId=<uuid>    — every eligible entity for one client
 *                                   (admin can pass any client; processors and
 *                                   managers are auto-pinned to their own
 *                                   profile.client_id and the param is ignored)
 *
 * For every entity that has:
 *   • signer_email populated
 *   • no signature_id yet
 *   • not already completed
 *   • form_type != 'W2_INCOME'
 * generate + send an 8821 via Dropbox Sign and update the entity with
 * signature_id + status='8821_sent'.
 *
 * Auth: admin / processor / manager session OR CRON_SECRET. Processors and
 * managers are scoped to their own client_id — they cannot fire across
 * clients even if they pass scope=all without a clientId.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { sendSignatureRequest } from '@/lib/dropbox-sign';
import { logAuditFromRequest } from '@/lib/audit';
import { requireBearer } from '@/lib/auth-util';

export async function POST(request: NextRequest) {
  try {
    // Auth gate — admin (any client), processor/manager (own client), or cron.
    const isCron = !requireBearer(request, process.env.CRON_SECRET);
    let userId: string | undefined;
    let userEmail: string | undefined;
    let userRole: string | undefined;
    let userClientId: string | null | undefined;
    if (!isCron) {
      const cookieStore = await cookies();
      const supabase = createServerRouteClient(cookieStore);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
      const admin = createAdminClient();
      const { data: profile } = await admin
        .from('profiles')
        .select('role, client_id')
        .eq('id', user.id)
        .single();
      const role = (profile as any)?.role;
      if (!profile || !['admin', 'processor', 'manager'].includes(role)) {
        return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
      }
      userId = user.id;
      userEmail = user.email;
      userRole = role;
      userClientId = (profile as any).client_id;

      // Non-admins must have a client_id — without one they have no scope and
      // a scope=all call would otherwise leak across clients.
      if (role !== 'admin' && !userClientId) {
        return NextResponse.json(
          { error: 'Your account is not associated with a client. Contact support.' },
          { status: 403 },
        );
      }
    }

    const admin = createAdminClient();
    const url = new URL(request.url);
    const requestId = url.searchParams.get('requestId');
    const entityId = url.searchParams.get('entityId');
    const scope = url.searchParams.get('scope');                  // 'all' → every pending entity in scope
    const requestedClientId = url.searchParams.get('clientId');   // raw query param
    const dryRun = url.searchParams.get('dryRun') === '1';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 500);

    // Effective client-scope: admins (and cron) can pass any clientId or none;
    // processors/managers are forced to their own profile.client_id regardless
    // of what's in the URL. Belt-and-suspenders against a malicious
    // ?clientId=other-tenant probe.
    const clientId =
      isCron || userRole === 'admin' ? requestedClientId : (userClientId || null);

    // Load the entity set to work on — callers pick one of three modes:
    //   (a) single entity          → ?entityId=...
    //   (b) single request         → ?requestId=...
    //   (c) every pending globally → ?scope=all  (optionally ?clientId=... to narrow)
    //
    // For non-admins, every mode is implicitly client-scoped: we add a
    // `requests.client_id = userClientId` filter via the inner join so the
    // query returns 0 rows if the resource belongs to another tenant.
    const isClientScoped = !isCron && userRole !== 'admin';
    let entities: any[] | null = null;
    if (entityId) {
      let q = admin
        .from('request_entities')
        .select('*, requests!inner(client_id)')
        .eq('id', entityId);
      if (isClientScoped) q = q.eq('requests.client_id', userClientId!);
      const { data } = await q as { data: any[] | null; error: any };
      entities = data;
    } else if (requestId) {
      let q = admin
        .from('request_entities')
        .select('*, requests!inner(client_id)')
        .eq('request_id', requestId);
      if (isClientScoped) q = q.eq('requests.client_id', userClientId!);
      const { data } = await q as { data: any[] | null; error: any };
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
    const isCron = !requireBearer(request, process.env.CRON_SECRET);
    let userRole: string | undefined;
    let userClientId: string | null | undefined;
    if (!isCron) {
      const cookieStore = await cookies();
      const supabase = createServerRouteClient(cookieStore);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
      const admin = createAdminClient();
      const { data: profile } = await admin
        .from('profiles')
        .select('role, client_id')
        .eq('id', user.id)
        .single();
      const role = (profile as any)?.role;
      if (!profile || !['admin', 'processor', 'manager'].includes(role)) {
        return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
      }
      userRole = role;
      userClientId = (profile as any).client_id;
      // Non-admins without a client_id can't have pending entities — short-circuit.
      if (role !== 'admin' && !userClientId) {
        return NextResponse.json({ pending: 0 });
      }
    }

    const admin = createAdminClient();
    const url = new URL(request.url);
    const requestedClientId = url.searchParams.get('clientId');
    // Non-admins are pinned to their own client, regardless of URL param.
    const clientId =
      isCron || userRole === 'admin' ? requestedClientId : (userClientId || null);

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
