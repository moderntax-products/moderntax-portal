/**
 * GET /api/processor/questions
 *   Returns the calling processor's recent Q&A history (last 10 by default).
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

  const limit = Math.min(Number(request.nextUrl.searchParams.get('limit') || 10), 50);
  const admin = createAdminClient();

  const { data, error } = await (admin.from('processor_questions' as any) as any)
    .select('id, question_text, ai_response, ai_confidence, status, escalated_reason, admin_response, created_at, ai_response_at')
    .eq('asked_by', user.id)
    .order('created_at', { ascending: false })
    .limit(limit) as { data: any[] | null; error: any };
  if (error) {
    console.error('[processor/questions] list failed:', error);
    return NextResponse.json({ error: 'Failed to load history' }, { status: 500 });
  }

  return NextResponse.json({ questions: data || [] });
}
