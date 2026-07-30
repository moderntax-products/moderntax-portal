/**
 * POST /api/entity/[entityId]/processor-summary
 *
 * Parses the entity's transcripts into the structured TaxLiabilityReport, turns
 * it into a plain-language summary a loan processor can read (see
 * lib/processor-summary), and stores it on gross_receipts.processor_summary so
 * the request page can render it above the raw file list.
 *
 * Auth: admin, or a processor/manager on the entity's client.
 * Matt 2026-07-29.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { buildTaxLiabilityReport } from '@/lib/tax-liability-report';
import { buildProcessorSummary, coverageFromFilenames } from '@/lib/processor-summary';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(_request: NextRequest, { params }: { params: Promise<{ entityId: string }> }) {
  try {
    const { entityId } = await params;
    if (!entityId) return NextResponse.json({ error: 'entityId required' }, { status: 400 });

    const cookieStore = await cookies();
    const sb = createServerRouteClient(cookieStore);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    const { data: profile } = await sb.from('profiles').select('role, client_id').eq('id', user.id).single() as {
      data: { role: string | null; client_id: string | null } | null;
    };
    if (!profile || !['admin', 'processor', 'manager'].includes(profile.role || '')) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const admin = createAdminClient();
    const { data: entity } = await admin.from('request_entities')
      .select('id, entity_name, tid, gross_receipts, transcript_urls, transcript_html_urls, requests!inner(client_id)')
      .eq('id', entityId).single() as { data: any };
    if (!entity) return NextResponse.json({ error: 'Entity not found' }, { status: 404 });

    if (profile.role !== 'admin' && entity.requests?.client_id !== profile.client_id) {
      return NextResponse.json({ error: 'Not authorized for this entity' }, { status: 403 });
    }

    // Prefer the HTML copies (parseable); fall back to any .html in the primary list.
    const allUrls: string[] = [
      ...(entity.transcript_html_urls || []),
      ...(entity.transcript_urls || []),
    ];
    const htmlUrls = Array.from(new Set(allUrls.filter((u: string) => u.toLowerCase().endsWith('.html'))));
    if (htmlUrls.length === 0) {
      return NextResponse.json({ error: 'No parseable (HTML) transcripts on this entity yet.' }, { status: 409 });
    }

    const transcripts: { source: string; html: string }[] = [];
    for (const u of htmlUrls) {
      const { data: file } = await admin.storage.from('uploads').download(u);
      if (!file) continue;
      transcripts.push({ source: u.split('/').pop() || u, html: await file.text() });
    }
    if (transcripts.length === 0) {
      return NextResponse.json({ error: 'Could not read transcripts from storage.' }, { status: 500 });
    }

    const report = buildTaxLiabilityReport(entity.entity_name, entity.tid, transcripts);
    const coverage = coverageFromFilenames([
      ...(entity.transcript_urls || []),
      ...(entity.transcript_html_urls || []),
    ]);
    const generatedAt = new Date().toISOString();
    const summary = buildProcessorSummary(report, coverage, generatedAt);

    const newGr = { ...(entity.gross_receipts || {}), processor_summary: summary };
    const { error: upErr } = await (admin.from('request_entities') as any)
      .update({ gross_receipts: newGr }).eq('id', entityId);
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

    return NextResponse.json({ ok: true, summary });
  } catch (err: any) {
    console.error('[processor-summary]', err);
    return NextResponse.json({ error: err?.message || 'Failed to build summary' }, { status: 500 });
  }
}
