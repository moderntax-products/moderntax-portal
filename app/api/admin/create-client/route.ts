/**
 * Create Client API Route
 * Creates a new client organization
 * POST /api/admin/create-client
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditEvent } from '@/lib/audit';

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

    // Verify admin role
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (!profile || profile.role !== 'admin') {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const { name, domain } = await request.json();

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json({ error: 'Client name is required' }, { status: 400 });
    }

    const trimmedName = name.trim();

    // Generate slug from name
    const slug = trimmedName
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');

    // Check for duplicate slug
    const { data: existing } = await supabase
      .from('clients')
      .select('id')
      .eq('slug', slug)
      .single();

    if (existing) {
      return NextResponse.json(
        { error: `A client with a similar name already exists` },
        { status: 409 }
      );
    }

    // Create client (use admin client to bypass RLS)
    const adminSupabase = createAdminClient();
    const { data: newClient, error: createError } = await adminSupabase
      .from('clients')
      .insert({
        name: trimmedName,
        slug,
        domain: domain?.trim() || null,
        intake_methods: ['pdf', 'csv', 'manual'],
        free_trial: true,
      })
      .select('id, name, slug')
      .single();

    if (createError || !newClient) {
      console.error('Failed to create client:', createError);
      return NextResponse.json(
        { error: 'Failed to create client' },
        { status: 500 }
      );
    }

    // Audit log
    await logAuditEvent(supabase, {
      action: 'client_created',
      userId: user.id,
      details: { clientId: newClient.id, clientName: trimmedName, slug },
    });

    return NextResponse.json({
      success: true,
      client: newClient,
    });
  } catch (error) {
    console.error('Create client error:', error);
    return NextResponse.json(
      { error: 'An unexpected error occurred' },
      { status: 500 }
    );
  }
}
