import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  const checks: Record<string, { status: string; latency_ms?: number; error?: string }> = {};
  const startTime = Date.now();

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

  // Pipeline stats
  try {
    const supabase = createAdminClient();
    const [pending, processing, completed] = await Promise.all([
      supabase.from('request_entities').select('*', { count: 'exact', head: true }).in('status', ['pending', '8821_sent', '8821_signed', 'irs_queue']),
      supabase.from('request_entities').select('*', { count: 'exact', head: true }).eq('status', 'processing'),
      supabase.from('request_entities').select('*', { count: 'exact', head: true }).eq('status', 'completed'),
    ]);

    checks.pipeline = {
      status: 'healthy',
      entities_pending: pending.count || 0,
      entities_processing: processing.count || 0,
      entities_completed: completed.count || 0,
    } as any;
  } catch (err) {
    checks.pipeline = { status: 'unhealthy', error: String(err) };
  }

  const allHealthy = Object.values(checks).every(c => c.status === 'healthy');

  return NextResponse.json({
    status: allHealthy ? 'healthy' : 'degraded',
    version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || 'dev',
    timestamp: new Date().toISOString(),
    uptime_ms: Date.now() - startTime,
    checks,
  }, { status: allHealthy ? 200 : 503 });
}
