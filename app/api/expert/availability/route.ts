/**
 * Expert Availability API
 * GET  — List expert's upcoming availability commitments
 * POST — Create a new availability commitment (expert commits to a time slot)
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { cookies } from 'next/headers';
import { createServerRouteClient } from '@/lib/supabase-server';

export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const adminSupabase = createAdminClient();
    const { data: profile } = await adminSupabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    const isAdmin = profile?.role === 'admin';

    // Admins see all, experts see own
    let query = adminSupabase
      .from('expert_availability' as any)
      .select('*, profiles(full_name, email)')
      .order('available_date', { ascending: true })
      .order('start_time', { ascending: true });

    if (!isAdmin) {
      query = query.eq('expert_id', user.id);
    }

    // Filter to upcoming only (default) unless ?all=true
    const showAll = request.nextUrl.searchParams.get('all') === 'true';
    if (!showAll) {
      const today = new Date().toISOString().split('T')[0];
      query = query.gte('available_date', today);
    }

    const { data, error } = await query;
    if (error) throw error;

    return NextResponse.json({ availability: data || [] });
  } catch (error) {
    console.error('GET availability error:', error);
    return NextResponse.json({ error: 'Failed to fetch availability' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const adminSupabase = createAdminClient();
    const body = await request.json();

    const {
      expertId,       // Admin can set for any expert; experts default to self
      availableDate,  // "2026-04-09"
      startTime,      // "09:00"
      endTime,        // "11:00"
      timezone,       // "America/New_York"
      callMode,       // "hold_and_transfer" | "irs_callback" | "ai_full"
      callbackPhone,  // optional override
      assignmentIds,  // optional: specific assignments to process
      notes,          // optional
    } = body;

    // Check role
    const { data: profile } = await adminSupabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    const isAdmin = profile?.role === 'admin';
    const targetExpertId = isAdmin && expertId ? expertId : user.id;

    // Validation
    if (!availableDate || !startTime || !endTime) {
      return NextResponse.json({ error: 'availableDate, startTime, and endTime are required' }, { status: 400 });
    }

    // Verify the date is a weekday
    const dateObj = new Date(availableDate + 'T12:00:00Z');
    const dayOfWeek = dateObj.getUTCDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      return NextResponse.json({ error: 'IRS PPS is only open Mon-Fri' }, { status: 400 });
    }

    // Verify the target expert exists and has required credentials
    const { data: expertProfile } = await adminSupabase
      .from('profiles')
      .select('id, full_name, caf_number, phone_number')
      .eq('id', targetExpertId)
      .single();

    if (!expertProfile) {
      return NextResponse.json({ error: 'Expert not found' }, { status: 404 });
    }

    if (!expertProfile.caf_number) {
      return NextResponse.json({ error: 'Expert missing CAF number' }, { status: 400 });
    }

    const effectiveCallbackPhone = callbackPhone || expertProfile.phone_number;
    const effectiveCallMode = callMode || 'hold_and_transfer';

    if (effectiveCallMode !== 'ai_full' && !effectiveCallbackPhone) {
      return NextResponse.json({ error: 'Phone number required for callback/transfer mode' }, { status: 400 });
    }

    // Create the availability commitment
    const { data: slot, error: insertError } = await adminSupabase
      .from('expert_availability' as any)
      .insert({
        expert_id: targetExpertId,
        available_date: availableDate,
        start_time: startTime,
        end_time: endTime,
        timezone: timezone || 'America/New_York',
        call_mode: effectiveCallMode,
        callback_phone: effectiveCallbackPhone,
        assignment_ids: assignmentIds || null,
        notes: notes || null,
        status: 'committed',
      })
      .select('*')
      .single();

    if (insertError) throw insertError;

    return NextResponse.json({
      success: true,
      availability: slot,
      message: `${expertProfile.full_name} committed to ${availableDate} ${startTime}-${endTime}. Calls will auto-fire at ${startTime}.`,
    });
  } catch (error) {
    console.error('POST availability error:', error);
    return NextResponse.json({ error: 'Failed to create availability' }, { status: 500 });
  }
}
