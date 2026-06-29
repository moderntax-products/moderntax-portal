/**
 * GET /api/admin/filing-intake-link?entityId=<uuid>
 *
 * Admin-only. Returns the no-login filing-intake URL for a ModernTax Direct
 * entity, so the team can send it to the taxpayer. The link is a signed token —
 * stateless, nothing to store.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { filingIntakeUrl } from '@/lib/intake-tokens';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const cookieStore = await cookies();
  const sb = createServerRouteClient(cookieStore);
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const { data: profile } = await sb.from('profiles').select('role').eq('id', user.id).single() as { data: { role: string } | null };
  if (profile?.role !== 'admin') return NextResponse.json({ error: 'Admin only' }, { status: 403 });

  const entityId = request.nextUrl.searchParams.get('entityId')?.trim();
  if (!entityId) return NextResponse.json({ error: 'entityId required' }, { status: 400 });

  const admin = createAdminClient();
  const { data: entity } = await admin.from('request_entities')
    .select('id, entity_name, signer_email, gross_receipts').eq('id', entityId).single() as { data: any };
  if (!entity) return NextResponse.json({ error: 'Entity not found' }, { status: 404 });

  const ready = !!entity.gross_receipts?.filing_seed?.years?.length;
  return NextResponse.json({
    url: filingIntakeUrl(entityId),
    entity_name: entity.entity_name,
    signer_email: entity.signer_email || null,
    ready,
    already_authorized: !!entity.gross_receipts?.filing_intake?.authorized,
    note: ready ? undefined : 'filing_seed not set — the form will show a "not ready yet" message until the seed is populated.',
  });
}
