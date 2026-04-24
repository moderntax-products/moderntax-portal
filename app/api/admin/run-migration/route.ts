/**
 * One-time migration runner endpoint.
 * POST /api/admin/run-migration
 *
 * Intentionally minimal: accepts a SQL body (text/plain or JSON { sql })
 * and runs it against Postgres via a transient `pg` client. Guarded by
 * CRON_SECRET so only operators with the secret can invoke it.
 *
 * Requires `DATABASE_URL` env (standard Vercel Supabase integration sets
 * this automatically). If it's missing, the endpoint returns 500 and the
 * caller should apply the SQL via the Supabase dashboard SQL editor.
 *
 * This route was added to apply the Mercury integration migration. It can
 * be removed once the migration workflow is moved to Supabase CLI + CI.
 */

import { NextRequest, NextResponse } from 'next/server';
// pg lacks TS types in this project — dynamic require avoids needing @types/pg
// eslint-disable-next-line
const { Client }: { Client: new (c: { connectionString: string }) => { connect: () => Promise<void>; query: (sql: string) => Promise<{ rowCount?: number; command?: string }>; end: () => Promise<void> } } = require('pg');

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (!authHeader || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING;
  if (!dbUrl) {
    return NextResponse.json(
      { error: 'DATABASE_URL not configured — apply SQL via Supabase dashboard SQL editor instead' },
      { status: 500 },
    );
  }

  let sql: string | undefined;
  const contentType = request.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const body = await request.json();
    sql = body.sql;
  } else {
    sql = await request.text();
  }

  if (!sql || !sql.trim()) {
    return NextResponse.json({ error: 'No SQL provided' }, { status: 400 });
  }

  const pg = new Client({ connectionString: dbUrl });
  try {
    await pg.connect();
    const result = await pg.query(sql);
    return NextResponse.json({
      success: true,
      rowCount: Array.isArray(result) ? result.reduce((s, r) => s + (r.rowCount || 0), 0) : result.rowCount || 0,
      command: Array.isArray(result) ? result.map(r => r.command) : result.command,
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'SQL execution failed', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  } finally {
    await pg.end().catch(() => {});
  }
}
