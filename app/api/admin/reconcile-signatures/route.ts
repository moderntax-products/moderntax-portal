/**
 * Reconcile Dropbox Sign signatures whose signed PDFs never landed in storage.
 *
 * POST /api/admin/reconcile-signatures
 *
 * Finds request_entities where:
 *   • signature_id IS NOT NULL
 *   • signed_8821_url IS NULL
 * and attempts to re-download the signed PDF from Dropbox Sign, upload it to
 * Supabase storage, and backfill the entity row the same way the webhook would
 * have if it had succeeded.
 *
 * Trigger this manually from admin UI after a Dropbox Sign outage, or let the
 * nightly cron hit it. Auth: admin session OR CRON_SECRET. Returns a report of
 * reconciled entities.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { downloadSignedPdf } from '@/lib/dropbox-sign';

export async function POST(request: NextRequest) {
  try {
    // Auth
    const authHeader = request.headers.get('authorization');
    const isCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
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
    }

    const admin = createAdminClient();
    const url = new URL(request.url);
    const dryRun = url.searchParams.get('dryRun') === '1';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 200);

    // Find pending entities — signed but no PDF.
    const { data: pending } = await admin
      .from('request_entities')
      .select('id, entity_name, signature_id, request_id, signer_email, status')
      .not('signature_id', 'is', null)
      .is('signed_8821_url', null)
      .limit(limit) as { data: any[] | null; error: any };

    const candidates = pending || [];
    const report: Array<{ entityId: string; entityName: string; signatureId: string; result: string; error?: string }> = [];

    for (const e of candidates) {
      if (dryRun) {
        report.push({
          entityId: e.id, entityName: e.entity_name, signatureId: e.signature_id, result: 'would_retry',
        });
        continue;
      }

      // Re-download the signed PDF from Dropbox Sign.
      let pdfBuffer: Buffer;
      try {
        pdfBuffer = await downloadSignedPdf(e.signature_id);
      } catch (dlError) {
        report.push({
          entityId: e.id, entityName: e.entity_name, signatureId: e.signature_id,
          result: 'download_failed',
          error: dlError instanceof Error ? dlError.message : String(dlError),
        });
        // Update the failure marker — keep the pointer to the latest error.
        await admin.from('audit_log' as any).insert({
          user_email: '',
          action: 'webhook_failed',
          entity_type: 'request_entity',
          entity_id: e.id,
          details: {
            source: 'reconcile_signatures',
            stage: 'download',
            signature_id: e.signature_id,
            request_id: e.request_id,
            error: dlError instanceof Error ? dlError.message : String(dlError),
            needs_reconcile: true,
            attempted_at: new Date().toISOString(),
          },
        });
        continue;
      }

      // Upload to storage using the same naming convention as the webhook.
      const storagePath = `8821/${e.id}/${Date.now()}-signed-8821.pdf`;
      const { error: upErr } = await admin.storage
        .from('uploads')
        .upload(storagePath, pdfBuffer, { contentType: 'application/pdf', upsert: true });
      if (upErr) {
        report.push({
          entityId: e.id, entityName: e.entity_name, signatureId: e.signature_id,
          result: 'upload_failed', error: upErr.message,
        });
        continue;
      }

      // Write signed_8821_url and bump status (only if still not at a later stage).
      const { error: updErr } = await admin
        .from('request_entities')
        .update({
          signed_8821_url: storagePath,
          status: ['pending', 'submitted', '8821_sent'].includes(e.status) ? '8821_signed' : e.status,
        })
        .eq('id', e.id);
      if (updErr) {
        report.push({
          entityId: e.id, entityName: e.entity_name, signatureId: e.signature_id,
          result: 'update_failed', error: updErr.message,
        });
        continue;
      }

      // Audit — mirror the successful-signature audit row the webhook writes.
      await admin.from('audit_log' as any).insert({
        user_email: e.signer_email || '',
        action: 'file_uploaded',
        entity_type: 'request_entity',
        entity_id: e.id,
        details: {
          action: '8821_reconciled_from_dropbox_sign',
          signature_id: e.signature_id,
          storage_path: storagePath,
          request_id: e.request_id,
          reconciled_at: new Date().toISOString(),
        },
      });

      report.push({
        entityId: e.id, entityName: e.entity_name, signatureId: e.signature_id, result: 'reconciled',
      });
    }

    const counts = report.reduce<Record<string, number>>((acc, r) => {
      acc[r.result] = (acc[r.result] || 0) + 1;
      return acc;
    }, {});

    return NextResponse.json({
      success: true,
      dry_run: dryRun,
      candidates_found: candidates.length,
      counts,
      details: report,
    });
  } catch (error) {
    console.error('reconcile-signatures error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest) {
  // Convenience: GET returns the count of candidates without mutating anything.
  // Useful for admin UI to show "N signatures awaiting reconciliation".
  try {
    const authHeader = request.headers.get('authorization');
    const isCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
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
    }

    const admin = createAdminClient();
    const { count } = await admin
      .from('request_entities')
      .select('id', { count: 'exact', head: true })
      .not('signature_id', 'is', null)
      .is('signed_8821_url', null);
    return NextResponse.json({ pending: count || 0 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
