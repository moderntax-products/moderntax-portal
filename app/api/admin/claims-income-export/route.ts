/**
 * GET /api/admin/claims-income-export?requestId=<uuid>
 *
 * Claims-verification deliverable (Guardian Life). A claim bundles MULTIPLE
 * parties — the insured, spouse (joint 1040), and any K-1 businesses — under one
 * request. This streams a single Excel workbook aggregating the whole bundle's
 * income with the earned-vs-passive split (lib/income-split + lib/claims-export).
 *
 * Income source per entity, in priority order:
 *   1. entity.gross_receipts.claims_income_sources  (cached / seeded fast-path)
 *   2. TODO(post-working-session): parse the entity's stored W&I transcripts via
 *      lib/wage-income-parser. Wired once Guardian confirms their transcript set.
 *
 * Auth: admin (any), manager/processor (own client), CRON bearer = admin.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { buildIncomeSplit } from '@/lib/income-split';
import { buildClaimsWorkbook } from '@/lib/claims-export';
import type { IncomeSource } from '@/lib/wage-income-parser';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization') || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const isService = !!process.env.CRON_SECRET && bearer === process.env.CRON_SECRET;

    let profile: { role: string | null; client_id: string | null } | null = null;
    if (isService) {
      profile = { role: 'admin', client_id: null };
    } else {
      const cookieStore = await cookies();
      const sb = createServerRouteClient(cookieStore);
      const { data: { user } } = await sb.auth.getUser();
      if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
      const { data } = await sb.from('profiles').select('role, client_id').eq('id', user.id).single() as {
        data: { role: string | null; client_id: string | null } | null;
      };
      profile = data;
    }
    if (!profile) return NextResponse.json({ error: 'No profile' }, { status: 403 });

    const requestId = new URL(request.url).searchParams.get('requestId')?.trim();
    if (!requestId) return NextResponse.json({ error: 'requestId query param required' }, { status: 400 });

    const admin = createAdminClient();
    const { data: req } = await admin.from('requests')
      .select('id, loan_number, client_id, clients(name)')
      .eq('id', requestId).single() as { data: any };
    if (!req) return NextResponse.json({ error: 'Claim not found' }, { status: 404 });

    let canView = profile.role === 'admin';
    if (!canView && ['manager', 'processor'].includes(profile.role || '')) {
      canView = !!req.client_id && req.client_id === profile.client_id;
    }
    if (!canView) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const { data: entities } = await admin.from('request_entities')
      .select('entity_name, tid, tid_kind, gross_receipts')
      .eq('request_id', requestId) as { data: any[] | null };

    // Collect income sources across every party in the bundle.
    const allSources: IncomeSource[] = [];
    for (const e of entities || []) {
      const seeded = e.gross_receipts?.claims_income_sources;
      if (Array.isArray(seeded)) {
        for (const s of seeded) {
          allSources.push({
            form_type: s.form_type, payer_ein: s.payer_ein || '', payer_name: s.payer_name || e.entity_name,
            payer_address: '', recipient_name: s.recipient_name || e.entity_name,
            recipient_tin_last_four: (e.tid || '').slice(-4), tax_year: String(s.tax_year), fields: s.fields || {},
          });
        }
      }
    }

    const split = buildIncomeSplit(allSources);
    const primary = (entities || [])[0];
    const xlsx = buildClaimsWorkbook(split, {
      claimantName: primary?.entity_name || 'Claimant',
      claimNumber: req.loan_number || undefined,
      tinLast4: (primary?.tid || '').slice(-4) || undefined,
      preparedFor: `${req.clients?.name || 'Client'} — Claims`,
      generatedOn: new Date().toISOString().slice(0, 10),
    });

    const safe = (req.loan_number || 'claim').replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 40);
    return new NextResponse(new Uint8Array(xlsx), {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="ModernTax-Claims-Income-${safe}.xlsx"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err: any) {
    console.error('[claims-income-export] error:', err);
    return NextResponse.json({ error: 'Failed to generate export', detail: err?.message || String(err) }, { status: 500 });
  }
}
