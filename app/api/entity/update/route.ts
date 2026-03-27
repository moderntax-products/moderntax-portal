/**
 * Entity Update API
 * PATCH /api/entity/update — Processor/Manager updates entity fields (signer email, address, etc.)
 * Only allowed on entities in 'pending' or 'submitted' status
 */

import { NextRequest, NextResponse } from 'next/server';
import { createServerComponentClient, createAdminClient } from '@/lib/supabase-server';
import { sendAdminReadyFor8821Notification } from '@/lib/sendgrid';

const EDITABLE_STATUSES = ['pending', 'submitted'];

const ALLOWED_FIELDS = [
  'signer_email',
  'signer_first_name',
  'signer_last_name',
  'address',
  'city',
  'state',
  'zip_code',
  'entity_name',
  'tid',
  'form_type',
];

export async function PATCH(request: NextRequest) {
  try {
    const supabase = await createServerComponentClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: profile } = await supabase
      .from('profiles')
      .select('role, client_id')
      .eq('id', user.id)
      .single() as { data: { role: string; client_id: string | null } | null; error: any };

    if (!profile || !['processor', 'manager', 'admin'].includes(profile.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const { entityId, updates } = body;

    if (!entityId) return NextResponse.json({ error: 'entityId is required' }, { status: 400 });
    if (!updates || typeof updates !== 'object') return NextResponse.json({ error: 'updates object is required' }, { status: 400 });

    // Fetch entity + request to verify ownership
    const { data: entity } = await supabase
      .from('request_entities')
      .select('id, status, request_id, requests(client_id, requested_by)')
      .eq('id', entityId)
      .single() as { data: any | null; error: any };

    if (!entity) return NextResponse.json({ error: 'Entity not found' }, { status: 404 });

    // Verify client access
    if (profile.role !== 'admin' && entity.requests?.client_id !== profile.client_id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Processors can only edit their own entities
    if (profile.role === 'processor' && entity.requests?.requested_by !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Check entity is in editable status
    if (!EDITABLE_STATUSES.includes(entity.status)) {
      return NextResponse.json({
        error: 'Entity cannot be edited',
        details: `Entity is in "${entity.status}" status. Only pending or submitted entities can be edited.`,
      }, { status: 400 });
    }

    // Filter to allowed fields only
    const safeUpdates: Record<string, any> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (ALLOWED_FIELDS.includes(key)) {
        safeUpdates[key] = value;
      }
    }

    if (Object.keys(safeUpdates).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    const { error: updateError } = await supabase
      .from('request_entities')
      .update(safeUpdates)
      .eq('id', entityId);

    if (updateError) {
      return NextResponse.json({ error: 'Failed to update entity', details: updateError.message }, { status: 500 });
    }

    // If signer_email was just added, check if all entities on this request now have emails
    // If so, notify admins that the request is ready for 8821 preparation
    if (safeUpdates.signer_email) {
      try {
        const adminSupabase = createAdminClient();
        const { data: allEntities } = await adminSupabase
          .from('request_entities')
          .select('id, entity_name, signer_email, form_type, status')
          .eq('request_id', entity.request_id) as { data: any[] | null; error: any };

        if (allEntities) {
          // Check if all non-W2 entities now have signer emails
          const needsEmail = allEntities.filter(
            (e: any) => e.form_type !== 'W2_INCOME' && !e.signer_email
          );

          if (needsEmail.length === 0) {
            // All entities ready — get request details and notify admins
            const { data: reqData } = await adminSupabase
              .from('requests')
              .select('loan_number, client_id')
              .eq('id', entity.request_id)
              .single() as { data: any; error: any };

            const { data: clientData } = await adminSupabase
              .from('clients')
              .select('name')
              .eq('id', reqData?.client_id || entity.requests?.client_id)
              .single() as { data: any; error: any };

            const { data: userProfile } = await adminSupabase
              .from('profiles')
              .select('full_name')
              .eq('id', user.id)
              .single() as { data: any; error: any };

            const { data: admins } = await adminSupabase
              .from('profiles')
              .select('email')
              .eq('role', 'admin');

            const entitiesWithEmails = allEntities
              .filter((e: any) => e.form_type !== 'W2_INCOME')
              .map((e: any) => ({
                entity_name: e.entity_name,
                signer_email: e.signer_email,
                form_type: e.form_type,
              }));

            if (admins && admins.length > 0) {
              for (const admin of admins) {
                await sendAdminReadyFor8821Notification(
                  admin.email,
                  userProfile?.full_name || user.email || 'Team Member',
                  clientData?.name || 'Unknown',
                  reqData?.loan_number || entity.request_id,
                  entitiesWithEmails,
                  entity.request_id
                );
              }
            }
          }
        }
      } catch (notifyErr) {
        console.error('Failed to send ready-for-8821 notification:', notifyErr);
        // Don't fail the update if notification fails
      }
    }

    return NextResponse.json({ success: true, updated: Object.keys(safeUpdates) });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: 'Internal server error', details: msg }, { status: 500 });
  }
}
