/**
 * GET /api/admin/storage-audit — where the `uploads` bucket weight is.
 *
 * Walks the bucket and returns size + file-count by top-level prefix, sorted
 * heaviest-first, so we can see storage growth before it trips a quota again.
 * Admin-only. Bounded by a scan cap (reports `capped: true` if hit).
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { auditByTopPrefix, fmtBytes } from '@/lib/storage-audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(_request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = createServerRouteClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single() as {
    data: { role: string } | null;
  };
  if (!profile || profile.role !== 'admin') {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }

  try {
    const admin = createAdminClient();
    const audit = await auditByTopPrefix(admin);
    return NextResponse.json({
      total: fmtBytes(audit.total_bytes),
      total_bytes: audit.total_bytes,
      total_files: audit.total_files,
      capped: audit.capped,
      prefixes: audit.prefixes.map((p) => ({ ...p, size: fmtBytes(p.bytes) })),
    });
  } catch (e: any) {
    return NextResponse.json({ error: 'Audit failed', detail: e?.message || String(e) }, { status: 500 });
  }
}
