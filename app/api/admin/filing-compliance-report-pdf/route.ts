/**
 * GET /api/admin/filing-compliance-report-pdf?entityId=<uuid>
 *
 * Streams the Tax-Guard-style Filing-Compliance Report as a downloadable PDF.
 * Reads the entity's IRS Account Transcripts, builds the report
 * (lib/compliance-report), and renders it (lib/compliance-report-pdf).
 *
 * Auth: admin (any entity), manager/processor (own client), assigned expert.
 * A valid CRON_SECRET bearer authenticates as admin-equivalent for ops/tests.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { buildComplianceReport } from '@/lib/compliance-report';
import { generateComplianceReportPdf } from '@/lib/compliance-report-pdf';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization') || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const isService = !!process.env.CRON_SECRET && bearer === process.env.CRON_SECRET;

    let profile: { role: string | null; client_id: string | null } | null = null;
    let userId: string | null = null;
    if (isService) {
      profile = { role: 'admin', client_id: null };
    } else {
      const cookieStore = await cookies();
      const sb = createServerRouteClient(cookieStore);
      const { data: { user } } = await sb.auth.getUser();
      if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
      userId = user.id;
      const { data } = await sb.from('profiles').select('role, client_id').eq('id', user.id).single() as {
        data: { role: string | null; client_id: string | null } | null;
      };
      profile = data;
    }
    if (!profile) return NextResponse.json({ error: 'No profile' }, { status: 403 });

    const entityId = new URL(request.url).searchParams.get('entityId')?.trim();
    if (!entityId) return NextResponse.json({ error: 'entityId query param required' }, { status: 400 });

    const admin = createAdminClient();
    const { data: entity } = await admin.from('request_entities')
      .select('id, entity_name, tid, tid_kind, transcript_urls, transcript_html_urls, request_id, requests(loan_number, client_id, clients(name))')
      .eq('id', entityId).single() as { data: any };
    if (!entity) return NextResponse.json({ error: 'Entity not found' }, { status: 404 });

    const entityClientId = entity.requests?.client_id;
    let canView = profile.role === 'admin';
    if (!canView && ['manager', 'processor', 'team_member'].includes(profile.role || '')) {
      canView = !!entityClientId && entityClientId === profile.client_id;
    }
    if (!canView && profile.role === 'expert' && userId) {
      const { data: assn } = await admin.from('expert_assignments')
        .select('id').eq('entity_id', entityId).eq('expert_id', userId).limit(1).maybeSingle() as { data: any };
      canView = !!assn;
    }
    if (!canView) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const allUrls: string[] = Array.from(new Set([
      ...(entity.transcript_urls || []),
      ...(entity.transcript_html_urls || []),
    ])).filter((u: string) => u.endsWith('.html'));
    const transcripts: { source: string; html: string }[] = [];
    for (const url of allUrls) {
      const { data: file } = await admin.storage.from('uploads').download(url);
      if (!file) continue;
      transcripts.push({ source: url, html: Buffer.from(await file.arrayBuffer()).toString('utf8') });
    }

    const report = buildComplianceReport(entity.entity_name, entity.tid, transcripts);
    const pdf = await generateComplianceReportPdf({
      entityName: entity.entity_name,
      tin: entity.tid,
      tidKind: entity.tid_kind,
      clientName: entity.requests?.clients?.name || 'Client',
      loanNumber: entity.requests?.loan_number || null,
    }, report);

    const safe = (entity.entity_name || 'entity').replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 40);
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="ModernTax-Compliance-Report-${safe}.pdf"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err: any) {
    console.error('[filing-compliance-report-pdf] error:', err);
    return NextResponse.json({ error: 'Failed to generate report PDF', detail: err?.message || String(err) }, { status: 500 });
  }
}
