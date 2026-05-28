/**
 * Admin-scoped 8821 download. Returns a short-lived signed URL for
 * either the borrower-signed PDF or the post-acceptance expert-regen'd
 * PDF (when one exists).
 *
 * Why this is separate from /api/expert/download-8821:
 *   · expert route requires an active assignment for the calling expert
 *   · admin route is unconstrained — admins frequently need to view PDFs
 *     for entities they're not assigned to (audit, reassignment review,
 *     borrower support)
 *
 * Both routes audit-log the download (SOC 2 CC7.2 — these PDFs contain
 * SSN, signature, and taxpayer identity data).
 *
 * GET /api/admin/download-8821?entityId=<uuid>&kind=signed|expert_regenerated
 *   default kind=signed
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';

export const runtime = 'nodejs';

const TTL_SECONDS = 3600; // 1 hour — matches expert route; data-H3 SOC 2 finding

export async function GET(request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = createServerRouteClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { data: profile } = await supabase
    .from('profiles').select('role').eq('id', user.id).single() as { data: { role: string } | null };
  if (profile?.role !== 'admin') return NextResponse.json({ error: 'Admin only' }, { status: 403 });

  const entityId = request.nextUrl.searchParams.get('entityId');
  if (!entityId) return NextResponse.json({ error: 'entityId required' }, { status: 400 });

  const kindParam = (request.nextUrl.searchParams.get('kind') || 'signed').toLowerCase();
  type Kind = 'signed' | 'expert_regenerated' | 'admin_uploaded';
  const kind: Kind = kindParam === 'expert_regenerated'
    ? 'expert_regenerated'
    : kindParam === 'admin_uploaded'
      ? 'admin_uploaded'
      : 'signed';

  const admin = createAdminClient();

  // Two-phase select so this works even if expert_regenerated_8821_url
  // and/or admin_uploaded_8821_url columns don't exist yet in older envs.
  // Both columns share the same migration-pending fallback shape.
  const baseSelect = 'signed_8821_url, entity_name';
  const fullSelect = `${baseSelect}, expert_regenerated_8821_url, admin_uploaded_8821_url`;

  let entity: any = null;
  let lookupErr: any = null;
  {
    const r = await admin.from('request_entities').select(fullSelect).eq('id', entityId).single() as { data: any; error: any };
    if (r.error && /expert_regenerated_8821_url|admin_uploaded_8821_url|column .* does not exist|PGRST204/i.test(r.error.message || '')) {
      const r2 = await admin.from('request_entities').select(baseSelect).eq('id', entityId).single() as { data: any; error: any };
      entity = r2.data ? { ...r2.data, expert_regenerated_8821_url: null, admin_uploaded_8821_url: null } : null;
      lookupErr = r2.error;
    } else {
      entity = r.data;
      lookupErr = r.error;
    }
  }
  if (lookupErr || !entity) {
    return NextResponse.json({ error: 'Entity not found' }, { status: 404 });
  }

  const storagePath = kind === 'expert_regenerated'
    ? entity.expert_regenerated_8821_url
    : kind === 'admin_uploaded'
      ? entity.admin_uploaded_8821_url
      : entity.signed_8821_url;

  if (!storagePath) {
    return NextResponse.json(
      {
        error: kind === 'expert_regenerated'
          ? 'No expert-regenerated 8821 on this entity. Use the "Regenerate 8821 w/ expert creds" button first.'
          : kind === 'admin_uploaded'
            ? 'No admin upload on this entity — the processor\'s original is the only PDF on file.'
            : 'No signed 8821 uploaded yet.',
      },
      { status: 404 },
    );
  }

  const { data: signed, error: signErr } = await admin.storage
    .from('uploads')
    .createSignedUrl(storagePath, TTL_SECONDS);
  if (signErr || !signed?.signedUrl) {
    console.error('[admin/download-8821] sign URL failed:', signErr);
    return NextResponse.json({ error: 'Failed to generate download link' }, { status: 500 });
  }

  // SOC 2 CC7.2 — audit every download. Signed PDFs contain SSN/EIN.
  try {
    await logAuditFromRequest(admin, request, {
      action: 'transcript_downloaded',
      userId: user.id,
      userEmail: user.email || '',
      resourceType: 'request_entity',
      resourceId: entityId,
      details: {
        file_kind: kind === 'expert_regenerated' ? 'expert_regenerated_8821' : 'signed_8821',
        file_path: storagePath,
        entity_name: entity.entity_name,
        role: 'admin',
        signed_url_ttl_seconds: TTL_SECONDS,
      },
    });
  } catch (auditErr) {
    console.error('[admin/download-8821] audit log failed:', auditErr);
  }

  return NextResponse.json({
    url: signed.signedUrl,
    entityName: entity.entity_name,
    kind,
    expiresInSeconds: TTL_SECONDS,
  });
}
