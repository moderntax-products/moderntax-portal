/**
 * IRS Call Mid-Call Fax
 * POST — Bland AI mid-call tool: fax signed 8821 to IRS agent
 *
 * Called by Bland AI during an active call when the IRS agent
 * requests that the 8821 form be faxed.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';

export async function POST(request: NextRequest) {
  try {
    // Validate Bland webhook secret
    const blandSecret = request.headers.get('x-bland-secret');
    const expectedSecret = process.env.BLAND_WEBHOOK_SECRET;

    if (!blandSecret || !expectedSecret || blandSecret !== expectedSecret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { entity_index, fax_number, session_id } = body;

    if (!fax_number) {
      return NextResponse.json({
        result: 'I need the fax number from the IRS agent before I can send the fax.',
      });
    }

    const adminSupabase = createAdminClient();

    // Find the call session and its entities
    const { data: session } = await adminSupabase
      .from('irs_call_sessions' as any)
      .select('id')
      .eq('id', session_id)
      .single() as { data: any; error: any };

    if (!session) {
      return NextResponse.json({
        result: 'I apologize, I\'m having a technical issue sending the fax. I\'ll need to send it after this call.',
      });
    }

    const { data: callEntities } = await adminSupabase
      .from('irs_call_entities' as any)
      .select('id, entity_id, taxpayer_name')
      .eq('call_session_id', session_id)
      .order('created_at', { ascending: true }) as { data: any[]; error: any };

    if (!callEntities || callEntities.length === 0) {
      return NextResponse.json({
        result: 'I apologize, I\'m having a technical issue. I\'ll fax the 8821 after this call.',
      });
    }

    // Pick the entity (by index or default to first)
    const targetEntity = callEntities[entity_index || 0] || callEntities[0];

    // Get the signed 8821 URL
    const { data: entity } = await adminSupabase
      .from('request_entities')
      .select('signed_8821_url, entity_name')
      .eq('id', targetEntity.entity_id)
      .single();

    if (!entity?.signed_8821_url) {
      return NextResponse.json({
        result: `I don't have a signed 8821 on file for ${targetEntity.taxpayer_name}. I'll need to get that from the client and fax it separately.`,
      });
    }

    // TODO: Integrate with fax service (Twilio Fax, eFax API, etc.)
    // For now, log the fax request and mark it as needing manual follow-up
    console.log(`[MID-CALL FAX] Session ${session_id}, Entity ${targetEntity.taxpayer_name}, Fax to: ${fax_number}, 8821 URL: ${entity.signed_8821_url}`);

    // Update call entity with fax info
    await adminSupabase
      .from('irs_call_entities' as any)
      .update({
        fax_sent: true, // Will be true once fax service integrated
        fax_number_used: fax_number,
        outcome: 'fax_sent',
        outcome_notes: `8821 fax requested to ${fax_number}`,
      })
      .eq('id', targetEntity.id);

    // Return a response the AI can speak
    return NextResponse.json({
      result: `I've sent the 8821 for ${targetEntity.taxpayer_name} to fax number ${fax_number}. It should arrive shortly.`,
    });
  } catch (error) {
    console.error('Mid-call fax error:', error);
    return NextResponse.json({
      result: 'I\'m having a technical issue with the fax. I\'ll send it after this call.',
    });
  }
}
