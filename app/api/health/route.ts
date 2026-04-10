import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  const checks: Record<string, { status: string; latency_ms?: number; error?: string }> = {};

  // Check Supabase connectivity
  try {
    const dbStart = Date.now();
    const supabase = createAdminClient();
    const { count: _count, error } = await supabase
      .from('requests')
      .select('*', { count: 'exact', head: true });

    checks.database = {
      status: error ? 'unhealthy' : 'healthy',
      latency_ms: Date.now() - dbStart,
      ...(error ? { error: error.message } : {}),
    };
  } catch (err) {
    checks.database = { status: 'unhealthy', error: String(err) };
  }

  // Check Supabase Storage
  try {
    const storageStart = Date.now();
    const supabase = createAdminClient();
    const { data: _buckets, error } = await supabase.storage.listBuckets();
    checks.storage = {
      status: error ? 'unhealthy' : 'healthy',
      latency_ms: Date.now() - storageStart,
    };
  } catch (err) {
    checks.storage = { status: 'unhealthy', error: String(err) };
  }

  const allHealthy = Object.values(checks).every(c => c.status === 'healthy');

  return NextResponse.json({
    status: allHealthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    checks: {
      database: { status: checks.database.status },
      storage: { status: checks.storage.status },
    },
  }, { status: allHealthy ? 200 : 503 });
}
