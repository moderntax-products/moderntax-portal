/**
 * Platform visibility — can every user on the platform actually place an order?
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-07-22 we found five separate people who looked like disinterested
 * signups and were in fact blocked by our own defects:
 *
 *   Joaquin Lavera (3rdst)          profile.client_id was NULL → every intake
 *   Stephen Barber (S. Grace)       route rejected them with 400 before doing
 *                                   anything. Signed up April, silent since.
 *   Elena Perceleanu (BFC)          402 card_required on an account WE opened
 *                                   and told her she could order from.
 *   Carla DeGuzman (Cal Statewide)  uploaded a wrong 8821 with no way to swap.
 *   Robin Kim (Centerstone)         413 on scanned 8821s — an ACTIVE processor
 *                                   with 51 orders, silently unable to upload.
 *
 * Every one of them was invisible until they emailed. Two never did — they
 * just stopped. The "1.6 orders/day against a 50/day target" number was never
 * a demand problem, and nothing in the admin surfaced that.
 *
 * This module answers one question for every user: could they order right now?
 * It runs the SAME checkOrderGate() the intake routes run, so the answer is
 * the real one rather than a guess. Anyone who cannot is a bug to fix, not an
 * audience to email harder.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { checkOrderGate } from '@/lib/order-gate';

export type BlockerKind =
  | 'no_client'          // profile.client_id IS NULL — hard 400 on every intake
  | 'gate_blocked'       // checkOrderGate() says no (402: card/credits/mercury)
  | 'not_approved'       // approval_status pending/rejected
  | 'gate_error';        // the gate itself threw — unknown state, treat as broken

export interface UserVisibilityRow {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  approval_status: string | null;
  client_id: string | null;
  client_name: string | null;
  created_at: string;
  daysSinceSignup: number;
  orderCount: number;
  lastOrderAt: string | null;
  /** True when this user could place an order right now. */
  canOrder: boolean;
  blocker: BlockerKind | null;
  /** Human-readable, specific enough to act on without opening the code. */
  blockerDetail: string | null;
  notificationsPaused: boolean;
  isInternal: boolean;
}

export interface PlatformVisibility {
  rows: UserVisibilityRow[];
  summary: {
    total: number;
    canOrder: number;
    blocked: number;
    neverOrdered: number;
    blockedAndNeverOrdered: number;
    internal: number;
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Demo/test logins that shouldn't be counted as real customers. */
export function isInternalAccount(email: string, fullName?: string | null): boolean {
  const e = (email || '').toLowerCase();
  const local = e.split('@')[0] || '';
  return (
    e.endsWith('@moderntax.io') ||
    // ClearFirm is a separate entity whose logins are used for API testing.
    e.endsWith('@getclearfirm.com') ||
    local.includes('+') ||
    /(^|[.\-_+])demo([.\-_+]|@)/.test(e) ||
    /\bdemo\b/i.test(fullName || '')
  );
}

/**
 * Build the platform-wide picture. Ordering-capable roles only — experts and
 * admins have no client by design and would show as false blockers.
 */
export async function getPlatformVisibility(
  admin: SupabaseClient,
): Promise<PlatformVisibility> {
  const { data: profs } = await admin
    .from('profiles')
    .select('id, email, full_name, role, approval_status, client_id, created_at, manager_notifications_paused, clients(name)')
    .in('role', ['processor', 'manager', 'direct_user'])
    .order('created_at', { ascending: false }) as { data: any[] | null };

  const rows: UserVisibilityRow[] = [];
  if (!profs?.length) {
    return { rows, summary: { total: 0, canOrder: 0, blocked: 0, neverOrdered: 0, blockedAndNeverOrdered: 0, internal: 0 } };
  }

  const { data: reqs } = await admin
    .from('requests')
    .select('requested_by, created_at') as { data: any[] | null };

  const counts = new Map<string, number>();
  const lastAt = new Map<string, string>();
  for (const r of reqs || []) {
    if (!r.requested_by) continue;
    counts.set(r.requested_by, (counts.get(r.requested_by) || 0) + 1);
    const prev = lastAt.get(r.requested_by);
    if (!prev || r.created_at > prev) lastAt.set(r.requested_by, r.created_at);
  }

  // One gate call per CLIENT, not per user — the gate is client-scoped and
  // several users share a client. Keeps this page fast as the book grows.
  const gateCache = new Map<string, { allowed: boolean; reason?: string; status?: number; error?: string }>();
  async function gateFor(clientId: string) {
    const hit = gateCache.get(clientId);
    if (hit) return hit;
    let val: { allowed: boolean; reason?: string; status?: number; error?: string };
    try {
      const g = await checkOrderGate(admin, clientId);
      val = { allowed: g.allowed, reason: g.reason, status: g.status };
    } catch (e: any) {
      val = { allowed: false, error: e?.message || String(e) };
    }
    gateCache.set(clientId, val);
    return val;
  }

  const now = Date.now();

  for (const p of profs) {
    const clientName = p.clients?.name ?? null;
    const orderCount = counts.get(p.id) || 0;
    let canOrder = true;
    let blocker: BlockerKind | null = null;
    let blockerDetail: string | null = null;

    if (p.approval_status && !['approved'].includes(p.approval_status)) {
      canOrder = false;
      blocker = 'not_approved';
      blockerDetail = `approval_status = ${p.approval_status}`;
    } else if (!p.client_id) {
      canOrder = false;
      blocker = 'no_client';
      blockerDetail = 'profile has no client_id — every intake route returns 400 "No client associated"';
    } else {
      const g = await gateFor(p.client_id);
      if (g.error) {
        canOrder = false;
        blocker = 'gate_error';
        blockerDetail = `order gate threw: ${g.error}`;
      } else if (!g.allowed) {
        canOrder = false;
        blocker = 'gate_blocked';
        blockerDetail = `order gate ${g.status || 402} ${g.reason || 'blocked'}`;
      }
    }

    rows.push({
      id: p.id,
      email: p.email,
      full_name: p.full_name,
      role: p.role,
      approval_status: p.approval_status ?? null,
      client_id: p.client_id ?? null,
      client_name: clientName,
      created_at: p.created_at,
      daysSinceSignup: Math.floor((now - +new Date(p.created_at)) / DAY_MS),
      orderCount,
      lastOrderAt: lastAt.get(p.id) ?? null,
      canOrder,
      blocker,
      blockerDetail,
      notificationsPaused: !!p.manager_notifications_paused,
      isInternal: isInternalAccount(p.email, p.full_name),
    });
  }

  // Blocked first, then never-ordered, then by recency — the top of this list
  // should always be the thing most worth fixing today.
  rows.sort((a, b) => {
    if (a.canOrder !== b.canOrder) return a.canOrder ? 1 : -1;
    if ((a.orderCount === 0) !== (b.orderCount === 0)) return a.orderCount === 0 ? -1 : 1;
    return +new Date(b.created_at) - +new Date(a.created_at);
  });

  const real = rows.filter((r) => !r.isInternal);
  return {
    rows,
    summary: {
      total: real.length,
      canOrder: real.filter((r) => r.canOrder).length,
      blocked: real.filter((r) => !r.canOrder).length,
      neverOrdered: real.filter((r) => r.orderCount === 0).length,
      blockedAndNeverOrdered: real.filter((r) => !r.canOrder && r.orderCount === 0).length,
      internal: rows.filter((r) => r.isInternal).length,
    },
  };
}
