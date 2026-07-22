import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { sendManagerEntityTranscriptNotification } from '@/lib/sendgrid';
import { RATE_ENTITY_TRANSCRIPT } from '@/lib/clients';

/**
 * POST /api/notify/entity-transcript
 * Sends manager notification when processor orders entity transcript add-on
 * Called from Manual Entry tab (client-side) after entities are created
 */
export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: profile } = (await supabase
      .from('profiles')
      .select('client_id, full_name')
      .eq('id', user.id)
      .single()) as { data: { client_id: string | null; full_name: string | null } | null; error: unknown };

    if (!profile?.client_id) {
      return NextResponse.json({ error: 'No client associated' }, { status: 400 });
    }

    const body = await request.json();
    const { request_id, loan_number, entity_count } = body;

    if (!request_id || !loan_number || !entity_count) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Get client name
    const { data: clientRecord } = await supabase
      .from('clients')
      .select('name')
      .eq('id', profile.client_id)
      .single() as { data: { name: string } | null; error: any };
    const clientName = clientRecord?.name || 'Unknown';

    // Find managers in the same client org, excluding anyone who opted out of
    // operational notifications. Guarded so pre-migration envs still work.
    const adminClient = createAdminClient();
    let managers: { email: string }[] | null = null;
    {
      const r = await adminClient.from('profiles').select('email')
        .eq('client_id', profile.client_id).eq('role', 'manager')
        .eq('manager_notifications_paused', false);
      if (r.error && /manager_notifications_paused|column .* does not exist|42703/i.test(r.error.message || '')) {
        const r2 = await adminClient.from('profiles').select('email')
          .eq('client_id', profile.client_id).eq('role', 'manager');
        managers = (r2.data as any) || null;
      } else {
        managers = (r.data as any) || null;
      }
    }

    if (managers && managers.length > 0) {
      const totalCost = entity_count * RATE_ENTITY_TRANSCRIPT;
      for (const manager of managers) {
        await sendManagerEntityTranscriptNotification(
          manager.email,
          profile.full_name || user.email || 'Team Member',
          clientName,
          loan_number,
          entity_count,
          totalCost,
          request_id
        );
      }
    }

    return NextResponse.json({ success: true, managers_notified: managers?.length || 0 });
  } catch (err) {
    console.error('[notify/entity-transcript] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Notification failed' },
      { status: 500 }
    );
  }
}
