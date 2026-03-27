/**
 * Employment Verification Result Endpoint
 * GET /api/webhook/employment-result?token=emp_...
 * PATCH /api/webhook/employment-result?token=emp_...
 *
 * GET: External backend checks if result is ready
 * PATCH: External backend pushes parsed employment_data back after processing
 *
 * Auth: x-api-key header validated against clients.api_key
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';

export async function GET(request: NextRequest) {
  try {
    const apiKey = request.headers.get('x-api-key');
    if (!apiKey) {
      return NextResponse.json(
        { error: 'Missing x-api-key header' },
        { status: 401 }
      );
    }

    const supabase = createAdminClient();

    // Validate API key
    const { data: client } = await supabase
      .from('clients')
      .select('id, name')
      .eq('api_key', apiKey)
      .single();

    if (!client) {
      return NextResponse.json(
        { error: 'Invalid API key' },
        { status: 401 }
      );
    }

    const token = request.nextUrl.searchParams.get('token');
    if (!token) {
      return NextResponse.json(
        { error: 'token query parameter is required' },
        { status: 400 }
      );
    }

    // Find request by external token, scoped to this client
    const { data: req } = await supabase
      .from('requests')
      .select('id, status, product_type, external_request_token, created_at, completed_at')
      .eq('external_request_token', token)
      .eq('client_id', client.id)
      .single();

    if (!req) {
      return NextResponse.json(
        { error: 'Request not found' },
        { status: 404 }
      );
    }

    // Get entity with employment data
    const { data: entities } = await supabase
      .from('request_entities')
      .select('id, entity_name, tid, status, employment_data, transcript_urls, completed_at')
      .eq('request_id', req.id);

    const entity = entities?.[0];

    if (req.status !== 'completed' || !entity?.employment_data) {
      return NextResponse.json({
        request_id: token,
        status: req.status === 'completed' ? 'completed' : 'pending_irs_call',
        request_status: req.status,
        entity_status: entity?.status || 'pending',
        message: 'Request is still being processed. Check back later.',
      });
    }

    // Completed - return full result
    // Generate signed URLs for transcripts if available
    let signedUrls: string[] = [];
    if (entity.transcript_urls && entity.transcript_urls.length > 0) {
      for (const url of entity.transcript_urls) {
        const { data: signedUrl } = await supabase.storage
          .from('transcripts')
          .createSignedUrl(url, 3600);
        if (signedUrl?.signedUrl) {
          signedUrls.push(signedUrl.signedUrl);
        }
      }
    }

    // Audit log
    await logAuditFromRequest(supabase, request, {
      action: 'employment_result_retrieved',
      resourceType: 'request',
      resourceId: req.id,
      details: {
        client_name: client.name,
        request_token: token,
      },
    });

    return NextResponse.json({
      request_id: token,
      status: 'completed',
      result: entity.employment_data,
      transcript_urls: signedUrls,
      completed_at: entity.completed_at || req.completed_at,
    });
  } catch (err) {
    console.error('Employment result GET error:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const apiKey = request.headers.get('x-api-key');
    if (!apiKey) {
      return NextResponse.json(
        { error: 'Missing x-api-key header' },
        { status: 401 }
      );
    }

    const supabase = createAdminClient();

    // Validate API key
    const { data: client } = await supabase
      .from('clients')
      .select('id, name')
      .eq('api_key', apiKey)
      .single();

    if (!client) {
      return NextResponse.json(
        { error: 'Invalid API key' },
        { status: 401 }
      );
    }

    const token = request.nextUrl.searchParams.get('token');
    if (!token) {
      return NextResponse.json(
        { error: 'token query parameter is required' },
        { status: 400 }
      );
    }

    const body = await request.json();
    if (!body.employment_data) {
      return NextResponse.json(
        { error: 'employment_data is required in request body' },
        { status: 400 }
      );
    }

    // Find request
    const { data: req } = await supabase
      .from('requests')
      .select('id, status')
      .eq('external_request_token', token)
      .eq('client_id', client.id)
      .single();

    if (!req) {
      return NextResponse.json(
        { error: 'Request not found' },
        { status: 404 }
      );
    }

    // Get entity
    const { data: entities } = await supabase
      .from('request_entities')
      .select('id')
      .eq('request_id', req.id);

    const entity = entities?.[0];
    if (!entity) {
      return NextResponse.json(
        { error: 'No entity found for this request' },
        { status: 404 }
      );
    }

    // Update entity with employment data
    const { error: updateError } = await supabase
      .from('request_entities')
      .update({
        employment_data: body.employment_data,
        status: 'completed',
        completed_at: new Date().toISOString(),
      })
      .eq('id', entity.id);

    if (updateError) {
      console.error('Entity update error:', updateError);
      return NextResponse.json(
        { error: 'Failed to update entity' },
        { status: 500 }
      );
    }

    // Update request status to completed
    await supabase
      .from('requests')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
      })
      .eq('id', req.id);

    // Audit log
    await logAuditFromRequest(supabase, request, {
      action: 'employment_result_retrieved',
      resourceType: 'request_entity',
      resourceId: entity.id,
      details: {
        client_name: client.name,
        request_token: token,
        request_id: req.id,
        action: 'employment_data_pushed',
      },
    });

    return NextResponse.json({
      success: true,
      request_id: req.id,
      entity_id: entity.id,
      status: 'completed',
    });
  } catch (err) {
    console.error('Employment result PATCH error:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
