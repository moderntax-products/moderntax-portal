/**
 * Verify Schedule Token
 * GET ?token=xxx — Returns expert info + pending entities for the schedule page
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';

export async function GET(request: NextRequest) {
  try {
    const token = request.nextUrl.searchParams.get('token');
    if (!token) {
      return NextResponse.json({ error: 'Token required' }, { status: 400 });
    }

    const supabase = createAdminClient();

    // Find the schedule token
    const { data: schedule, error } = await supabase
      .from('expert_schedule_tokens' as any)
      .select('*')
      .eq('token', token)
      .eq('status', 'pending')
      .single() as { data: any; error: any };

    if (error || !schedule) {
      return NextResponse.json({ error: 'This link has expired or already been used.' }, { status: 404 });
    }

    // Check if token is for today
    const today = new Date().toISOString().split('T')[0];
    if (schedule.schedule_date !== today) {
      return NextResponse.json({ error: 'This schedule link has expired. Check your email for today\'s link.' }, { status: 410 });
    }

    // Get expert profile
    const { data: profile } = await supabase
      .from('profiles')
      .select('full_name, phone_number')
      .eq('id', schedule.expert_id)
      .single();

    // Get pending assignments
    const { data: assignments } = await supabase
      .from('expert_assignments')
      .select('id, entity_id, request_entities(entity_name, tid_kind, form_type, years)')
      .eq('expert_id', schedule.expert_id)
      .in('status', ['assigned', 'in_progress']) as { data: any[] | null };

    const entities = (assignments || []).map((a: any) => ({
      assignmentId: a.id,
      entityName: a.request_entities?.entity_name || 'Unknown',
      tidKind: a.request_entities?.tid_kind || 'EIN',
      formType: a.request_entities?.form_type || '—',
      years: a.request_entities?.years || [],
    }));

    return NextResponse.json({
      expertName: profile?.full_name || 'Expert',
      callbackPhone: profile?.phone_number || '',
      entityCount: entities.length,
      entities,
      scheduleDate: schedule.schedule_date,
    });
  } catch (error) {
    console.error('Schedule verify error:', error);
    return NextResponse.json({ error: 'Verification failed' }, { status: 500 });
  }
}
