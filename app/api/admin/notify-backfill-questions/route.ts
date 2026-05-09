/**
 * Notify Processors — Backfill Question Digest
 * POST /api/admin/notify-backfill-questions
 *
 * Option-C interim mechanism: scan expert_assignments for notes tagged
 * "[BACKFILL]" (added when a migrated entity has partial/mismatched transcripts
 * that need processor input to unblock) and send a single email per processor
 * listing those questions alongside the existing backlog digest.
 *
 * Scoped by default to Centerstone SBA Lending — this is the only client with
 * open backfill questions right now, and Sonja (California Statewide CDC) has
 * completed her trial and is not relevant. Override with ?clientSlug=... or
 * ?clientId=... if the pattern expands to other clients.
 *
 * Auth: admin session OR cron secret.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { sendProcessorBacklogNotification } from '@/lib/sendgrid';
import { requireBearer } from '@/lib/auth-util';

const DEFAULT_CLIENT_SLUG = 'centerstone';

export async function POST(request: NextRequest) {
  try {
    // Auth: cron secret OR admin session.
    const isCron = !requireBearer(request, process.env.CRON_SECRET);
    if (!isCron) {
      const cookieStore = await cookies();
      const supabase = createServerRouteClient(cookieStore);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
      const adminSupabase = createAdminClient();
      const { data: profile } = await adminSupabase
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .single();
      if (!profile || (profile as any).role !== 'admin') {
        return NextResponse.json({ error: 'Admin only' }, { status: 403 });
      }
    }

    const admin = createAdminClient();

    // Resolve target client.
    const url = new URL(request.url);
    const clientIdParam = url.searchParams.get('clientId');
    const clientSlugParam = url.searchParams.get('clientSlug') || DEFAULT_CLIENT_SLUG;
    const dryRun = url.searchParams.get('dryRun') === '1';

    let client: any = null;
    if (clientIdParam) {
      const { data } = await admin.from('clients').select('id, name, slug').eq('id', clientIdParam).single();
      client = data;
    } else {
      const { data } = await admin.from('clients').select('id, name, slug').eq('slug', clientSlugParam).single();
      client = data;
    }
    if (!client) {
      return NextResponse.json({ error: `Client not found (slug=${clientSlugParam}, id=${clientIdParam || 'null'})` }, { status: 404 });
    }

    // Find all active assignments for this client whose expert_notes contain the
    // "[BACKFILL]" marker — written by the Centerstone Dropbox cleanup script.
    const { data: backfillAssignments } = await admin
      .from('expert_assignments')
      .select(`
        id, entity_id, expert_notes, status,
        request_entities!expert_assignments_entity_id_fkey (
          id, entity_name, request_id,
          requests!inner (
            id, client_id, loan_number, requested_by,
            profiles!requests_requested_by_fkey (full_name, email, role)
          )
        )
      `)
      .in('status', ['assigned', 'in_progress'])
      .ilike('expert_notes', '%[BACKFILL]%') as { data: any[] | null; error: any };

    const scoped = (backfillAssignments || []).filter(
      (a) => a.request_entities?.requests?.client_id === client.id,
    );

    if (scoped.length === 0) {
      return NextResponse.json({
        success: true,
        client: client.name,
        processors_notified: 0,
        questions_found: 0,
        message: 'No open backfill questions for this client.',
      });
    }

    // Group questions by processor (requests.requested_by → profiles.email).
    // If the request was submitted by admin/bot (e.g. ClearFirm pipeline), fall
    // back to all processor/manager profiles on the client's account. Sonja is
    // NOT on Centerstone so this naturally excludes her.
    type Q = {
      entityId: string;
      entityName: string;
      loanNumber: string;
      requestId: string;
      question: string;
    };
    const byProcessor = new Map<string, { profile: any; questions: Q[] }>();

    // Pre-fetch all Centerstone processors/managers to use as fallback recipients.
    const { data: allClientProcessors } = await admin
      .from('profiles')
      .select('id, email, full_name, role')
      .eq('client_id', client.id)
      .in('role', ['processor', 'manager']) as { data: any[] | null; error: any };
    const clientProcessorEmails = Array.from(new Set((allClientProcessors || [])
      .filter(p => !!p.email)
      .map(p => p.email.toLowerCase())));

    for (const a of scoped) {
      const e = a.request_entities;
      const r = e?.requests;
      if (!e || !r) continue;

      // Extract the [BACKFILL] line(s) from expert_notes. Keep only the
      // backfill-tagged portion so the processor isn't buried in unrelated notes.
      const matches = (a.expert_notes || '').match(/\[BACKFILL\][^\n]*/g) || [];
      const question = matches.join('\n').trim() || a.expert_notes;

      const q: Q = {
        entityId: e.id,
        entityName: e.entity_name || 'Unknown entity',
        loanNumber: r.loan_number || r.id.slice(0, 8),
        requestId: r.id,
        question,
      };

      // Attach to the request submitter first, if they're a processor/manager.
      const submitter = r.profiles;
      const submitterEmail = submitter?.email?.toLowerCase();
      if (submitterEmail && submitter?.role !== 'admin' && clientProcessorEmails.includes(submitterEmail)) {
        if (!byProcessor.has(submitterEmail)) byProcessor.set(submitterEmail, { profile: submitter, questions: [] });
        byProcessor.get(submitterEmail)!.questions.push(q);
      } else {
        // Fallback: fan out to all client processors/managers.
        for (const p of allClientProcessors || []) {
          const pe = p.email.toLowerCase();
          if (!byProcessor.has(pe)) byProcessor.set(pe, { profile: p, questions: [] });
          byProcessor.get(pe)!.questions.push(q);
        }
      }
    }

    // Dedupe: if a question was attached to both a submitter AND the fallback
    // fan-out (shouldn't happen with above logic, but belt-and-suspenders),
    // keep unique by entityId per recipient.
    for (const [, data] of byProcessor) {
      const seen = new Set<string>();
      data.questions = data.questions.filter(q => {
        if (seen.has(q.entityId)) return false;
        seen.add(q.entityId);
        return true;
      });
    }

    // Send — each processor gets a minimal-shape backlog email (empty
    // pendingRequests + zero summary) with the questions section rendered.
    // Existing `/api/admin/notify-processors` continues to handle the full
    // backlog digest; this endpoint is specifically for the question callout.
    let sent = 0;
    const recipients: { email: string; name: string; count: number }[] = [];
    for (const [email, data] of byProcessor) {
      recipients.push({ email, name: data.profile.full_name, count: data.questions.length });
      if (dryRun) continue;
      await sendProcessorBacklogNotification(
        data.profile.email,
        data.profile.full_name || 'there',
        client.name,
        [], // no pending request rows — this email is just the question digest
        { totalPending: 0, awaitingSignature: 0, inIrsQueue: 0, unassigned: 0, staleCount: 0 },
        data.questions,
      );
      sent++;
    }

    return NextResponse.json({
      success: true,
      client: client.name,
      questions_found: scoped.length,
      processors_notified: sent,
      dry_run: dryRun,
      recipients,
    });
  } catch (error) {
    console.error('Notify backfill questions error:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Internal server error' }, { status: 500 });
  }
}
