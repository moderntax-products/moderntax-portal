/**
 * GET /api/admin/entity-search?q=<term>
 *
 * Returns up to 20 entities matching the search term (entity name OR
 * TID OR loan_number). Admin-only. Drives the entity autocomplete
 * on the New ERC Engagement form.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = createServerRouteClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const { data: profile } = await supabase
    .from('profiles').select('role').eq('id', user.id).single() as { data: { role: string } | null };
  if (profile?.role !== 'admin') return NextResponse.json({ error: 'Admin only' }, { status: 403 });

  const q = (request.nextUrl.searchParams.get('q') || '').trim();
  if (!q || q.length < 2) return NextResponse.json({ entities: [] });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('request_entities')
    .select('id, entity_name, tid, status, requests(loan_number, clients(name))')
    .or(`entity_name.ilike.%${q}%,tid.ilike.%${q}%`)
    .order('updated_at', { ascending: false })
    .limit(20) as { data: any[] | null; error: any };
  if (error) {
    console.error('[entity-search]', error);
    return NextResponse.json({ error: 'Search failed' }, { status: 500 });
  }

  return NextResponse.json({
    entities: (data || []).map(e => ({
      id: e.id,
      entity_name: e.entity_name,
      tid: e.tid,
      status: e.status,
      client_name: e.requests?.clients?.name || null,
      loan_number: e.requests?.loan_number || null,
    })),
  });
}
