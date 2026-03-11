import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';

export async function GET() {
  try {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { data: callerProfile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (!callerProfile || callerProfile.role !== 'admin') {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const adminSupabase = createAdminClient();

    const { data: experts, error } = await adminSupabase
      .from('profiles')
      .select('id, email, full_name')
      .eq('role', 'expert')
      .order('full_name', { ascending: true });

    if (error) {
      console.error('Failed to fetch experts:', error);
      return NextResponse.json({ error: 'Failed to fetch experts' }, { status: 500 });
    }

    return NextResponse.json({ experts: experts || [] });
  } catch (error) {
    console.error('Expert list error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
