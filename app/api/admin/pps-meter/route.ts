/**
 * Admin PPS Call Meter API — the pilot's data spine.
 *
 * POST  — record a metered call (operator console). Derives costs server-side
 *         via lib/pps-call-meter so the numbers can't drift from the UI.
 * GET    — recent metered calls + the rolled-up pilot summary (avg
 *          human-min/entity vs the 51.3 baseline, cost/entity, completion,
 *          rejection, fax first-attempt success, automatable-wait share).
 *
 * Admin-only (cookie + role). No PII is accepted or stored (§5).
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { buildMeterRow, derivePpsCosts, summarizeMeters, type PpsMeterInput } from '@/lib/pps-call-meter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function requireAdmin() {
  const cookieStore = await cookies();
  const supabase = createServerRouteClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) } as const;
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single() as {
    data: { role: string } | null;
  };
  if (!profile || profile.role !== 'admin') {
    return { error: NextResponse.json({ error: 'Not authorized' }, { status: 403 }) } as const;
  }
  return { user } as const;
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;

  const body = (await request.json().catch(() => null)) as PpsMeterInput | null;
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  if (!body.client || !['centerstone', 'cal_statewide'].includes(body.client)) {
    return NextResponse.json({ error: 'client must be centerstone or cal_statewide' }, { status: 400 });
  }
  if (!body.outcome) return NextResponse.json({ error: 'outcome is required' }, { status: 400 });
  if (!body.entities_on_call || body.entities_on_call < 1) {
    return NextResponse.json({ error: 'entities_on_call must be ≥ 1' }, { status: 400 });
  }

  const admin = createAdminClient();
  const row = buildMeterRow(body, auth.user.id);
  const { data, error } = await (admin.from('pps_call_meter') as any)
    .insert(row).select('*').single() as { data: any; error: any };
  if (error) {
    console.error('[pps-meter] insert failed:', error.message);
    return NextResponse.json({ error: 'Failed to record call', detail: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, call: data, derived: derivePpsCosts(body) });
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;

  const admin = createAdminClient();
  const limit = Math.min(200, Number(request.nextUrl.searchParams.get('limit')) || 100);
  const { data: rows, error } = await admin.from('pps_call_meter')
    .select('*').order('started_at', { ascending: false }).limit(limit) as { data: any[] | null; error: any };
  if (error) {
    // Most likely cause pre-migration: table doesn't exist yet.
    return NextResponse.json({ error: 'Query failed — is the pps_call_meter migration applied?', detail: error.message }, { status: 500 });
  }

  const all = rows || [];
  return NextResponse.json({
    calls: all,
    summary: summarizeMeters(all),
    summary_manual: summarizeMeters(all.filter((r) => r.phase === 'manual')),
    summary_assisted: summarizeMeters(all.filter((r) => r.phase && r.phase !== 'manual')),
  });
}
