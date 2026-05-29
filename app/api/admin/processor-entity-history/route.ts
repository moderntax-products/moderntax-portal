/**
 * GET /api/admin/processor-entity-history?processor_id=UUID
 *
 * Returns every entity a given processor has submitted, deduped by TID
 * (so "Peter Geyen Inc" appearing on 3 prior requests collapses to one
 * card with the most-recent context). Drives the "reorder from history"
 * dropdown on /admin/email-intake — admin picks a processor, sees their
 * past entities, and re-fires a transcript pull without making the
 * processor re-upload a CSV + 8821.
 *
 * Driver: 2026-05-28 Matt — Soobin's "re-pull 2024 transcripts for
 * Peter Geyen" email. The entity is already in the system; the existing
 * 8821 is still on file. Admin should be able to one-click reorder.
 *
 * Per-entity payload includes the existing 8821 URL, signature freshness
 * (so the reorder route can decide whether to reuse it or trigger a
 * new signature flow), and the years previously pulled — so admin can
 * see "we already pulled 2022-2024 here" before picking new years.
 *
 * Auth: admin only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Same constant the reorder flow uses to gate 8821 reuse — keep in sync. */
const SIGNED_8821_VALID_DAYS = 120;

function normalizeTid(t: string | null | undefined): string {
  return (t || '').replace(/\D/g, '');
}

function daysAgo(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / (24 * 3600 * 1000));
}

export async function GET(request: NextRequest) {
  const cookieStore = await cookies();
  const sb = createServerRouteClient(cookieStore);
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { data: profile } = await sb.from('profiles').select('role').eq('id', user.id).single() as { data: { role: string } | null };
  // 2026-05-28 — widened beyond admin so processors / managers can use
  // the same endpoint to self-serve a reorder of their own historical
  // entities. Admin can query any processor_id; processor / manager can
  // only query their own user id (enforced below).
  if (!profile || !['admin', 'processor', 'manager'].includes(profile.role || '')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const processorId = request.nextUrl.searchParams.get('processor_id');
  if (!processorId) {
    return NextResponse.json({ error: 'processor_id required' }, { status: 400 });
  }

  // Non-admin callers can only fetch their OWN history — prevents one
  // processor from enumerating another's submitted entities.
  if (profile.role !== 'admin' && processorId !== user.id) {
    return NextResponse.json({ error: 'Can only fetch your own history' }, { status: 403 });
  }

  const admin = createAdminClient();

  // Confirm the target is actually a processor / manager so we don't
  // accidentally surface admin or expert "entities" through this surface.
  const { data: targetProfile } = await admin.from('profiles')
    .select('id, full_name, email, role, client_id, clients(name)')
    .eq('id', processorId).single() as { data: any };
  if (!targetProfile) {
    return NextResponse.json({ error: 'Processor not found' }, { status: 404 });
  }
  if (!['processor', 'manager'].includes(targetProfile.role)) {
    return NextResponse.json({ error: 'Target is not a processor/manager' }, { status: 400 });
  }

  // Pull every entity from requests this processor submitted. Join the
  // request row so we can show loan_number / created_at / status in the
  // dropdown. No date floor — admin should see all history.
  const { data: entities, error } = await admin
    .from('request_entities')
    .select(`
      id, entity_name, tid, tid_kind, form_type, years, status,
      signer_first_name, signer_last_name, signer_email,
      address, city, state, zip_code,
      signed_8821_url, signature_created_at,
      completed_at, created_at, transcript_urls, transcript_html_urls,
      requests!inner(id, loan_number, status, created_at, requested_by, client_id)
    `)
    .eq('requests.requested_by', processorId)
    .order('created_at', { ascending: false }) as { data: any[] | null; error: any };

  if (error) {
    console.error('[processor-entity-history]', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Dedupe by normalized TID. The first occurrence is the most recent
  // (the query is sorted DESC), so we keep that as the "head" entity
  // and roll the earlier ones into a `prior_count` + `prior_years` set
  // for context in the UI.
  type HeadEntry = {
    head: any;
    priorRequests: Array<{ request_id: string; loan_number: string | null; created_at: string; years: any; status: string }>;
    yearsPulledSet: Set<string>;
  };
  const headByTid = new Map<string, HeadEntry>();
  for (const e of entities || []) {
    const norm = normalizeTid(e.tid);
    if (!norm) continue;
    if (!headByTid.has(norm)) {
      headByTid.set(norm, { head: e, priorRequests: [], yearsPulledSet: new Set() });
    }
    const slot = headByTid.get(norm)!;
    // Track every prior request this TID appeared on (including the
    // head one — useful for the dropdown subtitle).
    slot.priorRequests.push({
      request_id: e.requests?.id,
      loan_number: e.requests?.loan_number || null,
      created_at: e.created_at,
      years: e.years,
      status: e.status,
    });
    // Aggregate years previously pulled so admin can see what's already on file.
    if (Array.isArray(e.years)) {
      for (const y of e.years) slot.yearsPulledSet.add(String(y));
    }
  }

  const items = Array.from(headByTid.values()).map(({ head, priorRequests, yearsPulledSet }) => {
    const sigAgeDays = daysAgo(head.signature_created_at);
    const sigStillValid = !!head.signed_8821_url && sigAgeDays !== null && sigAgeDays <= SIGNED_8821_VALID_DAYS;
    const transcriptCount =
      (Array.isArray(head.transcript_urls) ? head.transcript_urls.length : 0) +
      (Array.isArray(head.transcript_html_urls) ? head.transcript_html_urls.length : 0);
    return {
      entity_id: head.id,
      entity_name: head.entity_name,
      tid: head.tid,
      tid_kind: head.tid_kind,
      tid_masked: maskTid(head.tid, head.tid_kind),
      form_type: head.form_type,
      signer_first_name: head.signer_first_name,
      signer_last_name: head.signer_last_name,
      signer_email: head.signer_email,
      address: head.address,
      city: head.city,
      state: head.state,
      zip_code: head.zip_code,
      latest_loan_number: head.requests?.loan_number || null,
      latest_request_id: head.requests?.id || null,
      latest_status: head.status,
      latest_completed_at: head.completed_at,
      latest_created_at: head.created_at,
      years_previously_pulled: Array.from(yearsPulledSet).sort(),
      prior_request_count: priorRequests.length,
      prior_requests: priorRequests.slice(0, 10), // cap for payload size
      transcript_count: transcriptCount,
      signed_8821_url: head.signed_8821_url,
      signature_created_at: head.signature_created_at,
      signature_age_days: sigAgeDays,
      signature_still_valid: sigStillValid,
      signed_8821_valid_window_days: SIGNED_8821_VALID_DAYS,
    };
  });

  return NextResponse.json({
    processor: {
      id: targetProfile.id,
      full_name: targetProfile.full_name,
      email: targetProfile.email,
      role: targetProfile.role,
      client_id: targetProfile.client_id,
      client_name: targetProfile.clients?.name || null,
    },
    count: items.length,
    items,
  });
}

/** Display "**-**1727" — last 4 digits only. */
function maskTid(t: string | null | undefined, kind: string | null | undefined): string {
  const digits = normalizeTid(t);
  if (digits.length < 4) return t || '';
  const last4 = digits.slice(-4);
  if (kind === 'SSN' || kind === 'ITIN') return `***-**-${last4}`;
  return `**-***${last4}`;
}
