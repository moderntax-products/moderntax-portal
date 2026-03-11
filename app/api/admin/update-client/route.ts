import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';

export async function POST(request: Request) {
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

    const body = await request.json();
    const { clientId, free_trial } = body;

    if (!clientId || typeof free_trial !== 'boolean') {
      return NextResponse.json(
        { error: 'Missing required fields: clientId, free_trial (boolean)' },
        { status: 400 }
      );
    }

    const adminSupabase = createAdminClient();

    const { error: updateError } = await adminSupabase
      .from('clients')
      .update({ free_trial })
      .eq('id', clientId);

    if (updateError) {
      console.error('Failed to update client:', updateError);
      return NextResponse.json(
        { error: updateError.message },
        { status: 500 }
      );
    }

    await logAuditFromRequest(adminSupabase, request, {
      action: 'settings_changed',
      userId: user.id,
      userEmail: user.email || '',
      resourceType: 'client',
      resourceId: clientId,
      details: { free_trial },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Update client error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
