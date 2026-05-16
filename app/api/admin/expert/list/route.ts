import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { validateExpertDesigneeCreds } from '@/lib/8821-pdf';

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
      .select('id, email, full_name, caf_number, ptin, phone_number, fax_number, address, city, state, zip_code')
      .eq('role', 'expert')
      .order('full_name', { ascending: true }) as { data: any[] | null; error: any };

    if (error) {
      console.error('Failed to fetch experts:', error);
      return NextResponse.json({ error: 'Failed to fetch experts' }, { status: 500 });
    }

    // Decorate each expert with cred-completion info so the assign UI can
    // surface a warning + block the action before the API rejects.
    const decorated = (experts || []).map((e: any) => {
      const missing = validateExpertDesigneeCreds(e);
      return {
        id: e.id,
        email: e.email,
        full_name: e.full_name,
        // For privacy + smaller payload, never return raw CAF/PTIN to the
        // client — only the binary "are they complete" flag and which
        // fields are missing.
        designee_creds_complete: missing.length === 0,
        missing_designee_fields: missing,
      };
    });

    return NextResponse.json({ experts: decorated });
  } catch (error) {
    console.error('Expert list error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
