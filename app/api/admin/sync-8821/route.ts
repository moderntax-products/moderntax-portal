/**
 * Admin Sync 8821 from Dropbox Sign
 * GET  /api/admin/sync-8821 — List all completed signature requests, show match status
 * POST /api/admin/sync-8821 — Download and attach signed PDFs for matched entities
 */

import { NextRequest, NextResponse } from 'next/server';
import { createServerComponentClient, createAdminClient } from '@/lib/supabase-server';
import { downloadSignedPdf } from '@/lib/dropbox-sign';
import { sendStatusChangeNotification } from '@/lib/sendgrid';
import * as DropboxSign from '@dropbox/sign';

const API_KEY = process.env.DROPBOX_SIGN_API_KEY || '';

function getApi(): DropboxSign.SignatureRequestApi {
  const api = new DropboxSign.SignatureRequestApi();
  api.username = API_KEY;
  return api;
}

export async function GET(_request: NextRequest) {
  try {
    const supabase = await createServerComponentClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single() as { data: { role: string } | null; error: any };

    if (!profile || profile.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Get all completed signature requests from Dropbox Sign
    const api = getApi();
    const allRequests: any[] = [];
    let page = 1;

    while (page <= 5) { // Max 5 pages (100 results)
      const result = await api.signatureRequestList(undefined, page, 20, 'complete');
      const requests = result.body?.signatureRequests || [];
      if (requests.length === 0) break;
      allRequests.push(...requests);
      page++;
    }

    // Get all portal entities for matching
    const admin = createAdminClient();
    const { data: entities } = await admin
      .from('request_entities')
      .select('id, entity_name, signature_id, signed_8821_url, status, request_id') as { data: any[] | null; error: any };

    const entityByName = new Map<string, any>();
    const entityBySigId = new Map<string, any>();
    (entities || []).forEach((e: any) => {
      entityByName.set(e.entity_name.toLowerCase().trim(), e);
      if (e.signature_id) entityBySigId.set(e.signature_id, e);
    });

    // Match Dropbox Sign requests to portal entities
    const matched: any[] = [];
    const unmatched: any[] = [];

    for (const req of allRequests) {
      const sigId = req.signatureRequestId;
      const title = req.title || '';
      // Extract entity name from title: "8821 Consent Form Request - Entity Name"
      const entityName = title.replace(/^8821 Consent Form Request\s*-\s*/i, '').trim();
      const signers = (req.signatures || []).map((s: any) => ({
        name: s.signerName,
        email: s.signerEmailAddress,
        status: s.statusCode,
      }));

      // Try matching by signature_id first, then by name
      let portalEntity = entityBySigId.get(sigId) || entityByName.get(entityName.toLowerCase().trim());

      const item = {
        signatureRequestId: sigId,
        title,
        entityName,
        signers,
        createdAt: new Date((req.createdAt || 0) * 1000).toISOString(),
        hasPortalEntity: !!portalEntity,
        portalEntityId: portalEntity?.id || null,
        alreadySynced: portalEntity?.signed_8821_url ? true : false,
        portalStatus: portalEntity?.status || null,
      };

      if (portalEntity) {
        matched.push(item);
      } else {
        unmatched.push(item);
      }
    }

    return NextResponse.json({
      total: allRequests.length,
      matched: matched.length,
      unmatched: unmatched.length,
      matchedItems: matched,
      unmatchedItems: unmatched,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: 'Failed to sync', details: msg }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerComponentClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single() as { data: { role: string } | null; error: any };

    if (!profile || profile.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const { items } = body as { items: { signatureRequestId: string; portalEntityId: string }[] };

    if (!items || !Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'items array required' }, { status: 400 });
    }

    const admin = createAdminClient();
    let synced = 0;
    let failed = 0;
    const results: any[] = [];

    for (const item of items) {
      try {
        // Download signed PDF
        const pdfBuffer = await downloadSignedPdf(item.signatureRequestId);

        // Upload to Supabase storage
        const timestamp = Date.now();
        const storagePath = `8821/${item.portalEntityId}/${timestamp}-signed-8821.pdf`;

        const { error: uploadError } = await admin.storage
          .from('uploads')
          .upload(storagePath, pdfBuffer, {
            contentType: 'application/pdf',
            upsert: true,
          });

        if (uploadError) {
          console.error(`[sync-8821] Upload failed for ${item.portalEntityId}:`, uploadError);
          failed++;
          results.push({ entityId: item.portalEntityId, success: false, error: 'Upload failed' });
          continue;
        }

        // Get current entity status
        const { data: entity } = await admin
          .from('request_entities')
          .select('status, entity_name, request_id')
          .eq('id', item.portalEntityId)
          .single() as { data: any; error: any };

        const oldStatus = entity?.status || 'pending';

        // Update entity
        await admin
          .from('request_entities')
          .update({
            signed_8821_url: storagePath,
            signature_id: item.signatureRequestId,
            status: '8821_signed',
            signature_created_at: new Date().toISOString(),
          })
          .eq('id', item.portalEntityId);

        // Notify processor
        if (entity?.request_id) {
          try {
            const { data: req } = await admin
              .from('requests')
              .select('requested_by, loan_number')
              .eq('id', entity.request_id)
              .single();

            if (req) {
              const { data: processor } = await admin
                .from('profiles')
                .select('email, full_name')
                .eq('id', req.requested_by)
                .single();

              if (processor) {
                await sendStatusChangeNotification(
                  processor.email,
                  processor.full_name || processor.email,
                  entity.entity_name,
                  req.loan_number,
                  oldStatus,
                  '8821_signed'
                );
              }
            }
          } catch (notifErr) {
            console.error('[sync-8821] Notification error:', notifErr);
          }
        }

        synced++;
        results.push({ entityId: item.portalEntityId, entityName: entity?.entity_name, success: true });
        console.log(`[sync-8821] Synced: ${entity?.entity_name}`);
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : 'Unknown error';
        results.push({ entityId: item.portalEntityId, success: false, error: msg });
        console.error(`[sync-8821] Failed for ${item.portalEntityId}:`, msg);
      }
    }

    return NextResponse.json({ synced, failed, results });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: 'Sync failed', details: msg }, { status: 500 });
  }
}
