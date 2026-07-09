/**
 * POST /api/entity/8821-autogen
 *
 * Body: { requestId: string }
 *
 * Generates populated Forms 8821 for every entity on the caller's request
 * that doesn't already carry a signed 8821, stores each copy, and emails the
 * set to the caller (the ordering party) for signature collection. Called by
 * the manual-entry flow right after it creates the request; the CSV intake
 * calls lib/8821-autogen server-side directly.
 *
 * Auth: authenticated user whose client owns the request (admins: any).
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { autoGenerate8821sForRequest } from '@/lib/8821-autogen';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const body = (await request.json().catch(() => null)) as { requestId?: string } | null;
    const requestId = body?.requestId?.trim();
    if (!requestId) return NextResponse.json({ error: 'requestId required' }, { status: 400 });

    const { data: profile } = await supabase
      .from('profiles').select('role, client_id, full_name').eq('id', user.id).single() as {
        data: { role: string | null; client_id: string | null; full_name: string | null } | null;
      };
    if (!profile) return NextResponse.json({ error: 'No profile' }, { status: 403 });

    const admin = createAdminClient();
    const { data: req } = await admin.from('requests')
      .select('id, client_id').eq('id', requestId).single() as { data: { id: string; client_id: string } | null };
    if (!req) return NextResponse.json({ error: 'Request not found' }, { status: 404 });

    const isAdmin = profile.role === 'admin';
    if (!isAdmin && (!profile.client_id || req.client_id !== profile.client_id)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const result = await autoGenerate8821sForRequest(admin, requestId, {
      email: user.email || '',
      name: profile.full_name,
    });

    return NextResponse.json({
      success: true,
      generated: result.generated.length,
      skipped: result.skipped.length,
      emailed: result.emailed,
      emailedTo: result.emailedTo,
      entities: result.generated.map(g => g.entityName),
    });
  } catch (err: any) {
    console.error('[entity/8821-autogen] error:', err);
    return NextResponse.json({ error: 'Failed to generate 8821s', detail: err?.message }, { status: 500 });
  }
}
