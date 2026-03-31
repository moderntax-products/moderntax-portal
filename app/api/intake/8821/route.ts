/**
 * 8821 Data Upload API
 * POST /api/intake/8821
 *
 * Allows API partners (e.g. Clearfirm) to upload completed/signed 8821
 * data as a CSV. Matches rows to existing request entities by
 * request_token + entity_name (or entity_id) and attaches signed 8821
 * metadata so processors/experts can proceed with IRS retrieval.
 *
 * Also accepts direct PDF uploads of signed 8821 forms per entity.
 *
 * Auth: x-api-key header validated against clients.api_key
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import * as XLSX from 'xlsx';

// --- Types ---

interface Entity8821Row {
  request_token: string;
  entity_id?: string;
  entity_name?: string;
  signer_first_name?: string;
  signer_last_name?: string;
  signer_email?: string;
  signature_date?: string;
  signed?: string; // "yes"/"true" flag
}

interface JsonEntity8821 {
  request_token: string;
  entity_id?: string;
  entity_name?: string;
  signer_first_name?: string;
  signer_last_name?: string;
  signer_email?: string;
  signature_date?: string;
}

// --- Helpers ---

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, '_');
}

function mapRow(raw: Record<string, unknown>): Entity8821Row {
  const n: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    n[normalizeHeader(key)] = String(value ?? '').trim();
  }
  return {
    request_token: n['request_token'] || n['requesttoken'] || n['token'] || '',
    entity_id: n['entity_id'] || n['entityid'] || '',
    entity_name: n['entity_name'] || n['entityname'] || n['legal_name'] || n['legalname'] || '',
    signer_first_name: n['signer_first_name'] || n['first_name'] || n['firstname'] || '',
    signer_last_name: n['signer_last_name'] || n['last_name'] || n['lastname'] || '',
    signer_email: n['signer_email'] || n['email'] || '',
    signature_date: n['signature_date'] || n['signed_date'] || n['signature_created_at'] || '',
    signed: n['signed'] || n['completed'] || n['status'] || '',
  };
}

function parseSignatureDate(raw: string): string | null {
  if (!raw) return null;
  const num = Number(raw);
  if (!isNaN(num) && num > 40000 && num < 60000) {
    const excelEpoch = new Date(1899, 11, 30);
    const date = new Date(excelEpoch.getTime() + num * 86400000);
    return date.toISOString();
  }
  const parsed = new Date(raw);
  if (!isNaN(parsed.getTime())) return parsed.toISOString();
  return null;
}

// --- Route ---

export async function POST(request: NextRequest) {
  try {
    // --- Auth ---
    const apiKey = request.headers.get('x-api-key');
    if (!apiKey) {
      return NextResponse.json({ error: 'Missing x-api-key header' }, { status: 401 });
    }

    const supabase = createAdminClient();

    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('id, name, slug')
      .eq('api_key', apiKey)
      .single();

    if (clientError || !client) {
      return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
    }

    // --- Determine content type ---
    const contentType = request.headers.get('content-type') || '';
    let rows: Entity8821Row[] = [];

    if (contentType.includes('multipart/form-data')) {
      // CSV / Excel file upload
      const formData = await request.formData();
      const file = formData.get('file') as File | null;

      if (!file) {
        return NextResponse.json({ error: 'No file uploaded. Send a CSV/XLSX file as "file" field.' }, { status: 400 });
      }

      const buffer = Buffer.from(await file.arrayBuffer());

      // Store the uploaded file
      const filePath = `${client.id}/8821-data/${Date.now()}-${file.name}`;
      await supabase.storage.from('uploads').upload(filePath, buffer, {
        contentType: file.type,
        upsert: false,
      });

      // Parse
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);

      if (rawRows.length === 0) {
        return NextResponse.json({ error: 'File contains no data rows' }, { status: 400 });
      }

      rows = rawRows.map(mapRow);
    } else if (contentType.includes('application/json')) {
      // JSON payload
      const body = await request.json();

      if (!body.entities || !Array.isArray(body.entities) || body.entities.length === 0) {
        return NextResponse.json(
          { error: 'entities array is required. Each entry needs request_token and entity_name or entity_id.' },
          { status: 400 }
        );
      }

      rows = (body.entities as JsonEntity8821[]).map((e: JsonEntity8821) => ({
        request_token: e.request_token || '',
        entity_id: e.entity_id || '',
        entity_name: e.entity_name || '',
        signer_first_name: e.signer_first_name || '',
        signer_last_name: e.signer_last_name || '',
        signer_email: e.signer_email || '',
        signature_date: e.signature_date || '',
        signed: 'yes',
      }));
    } else {
      return NextResponse.json(
        { error: 'Content-Type must be multipart/form-data (CSV upload) or application/json' },
        { status: 400 }
      );
    }

    // --- Validate rows ---
    const errors: string[] = [];
    rows.forEach((row, idx) => {
      if (!row.request_token) errors.push(`Row ${idx + 1}: missing request_token`);
      if (!row.entity_id && !row.entity_name) errors.push(`Row ${idx + 1}: must have entity_id or entity_name`);
    });

    if (errors.length > 0) {
      return NextResponse.json({ error: 'Validation errors', details: errors.slice(0, 20) }, { status: 400 });
    }

    // --- Process each row ---
    const results: Array<{
      row: number;
      request_token: string;
      entity_name?: string;
      status: 'updated' | 'not_found' | 'error';
      entity_id?: string;
      message?: string;
    }> = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      try {
        // Find the request by external_request_token scoped to this client
        const { data: req } = await supabase
          .from('requests')
          .select('id')
          .eq('external_request_token', row.request_token)
          .eq('client_id', client.id)
          .maybeSingle();

        if (!req) {
          results.push({
            row: i + 1,
            request_token: row.request_token,
            entity_name: row.entity_name,
            status: 'not_found',
            message: `No request found for token "${row.request_token}"`,
          });
          continue;
        }

        // Find the entity — by entity_id or by name within the request
        let entityQuery = supabase
          .from('request_entities')
          .select('id, entity_name, status')
          .eq('request_id', req.id);

        if (row.entity_id) {
          entityQuery = entityQuery.eq('id', row.entity_id);
        } else if (row.entity_name) {
          entityQuery = entityQuery.ilike('entity_name', row.entity_name);
        }

        const { data: entities } = await entityQuery;

        if (!entities || entities.length === 0) {
          results.push({
            row: i + 1,
            request_token: row.request_token,
            entity_name: row.entity_name,
            status: 'not_found',
            message: `No entity found matching "${row.entity_id || row.entity_name}" in request ${row.request_token}`,
          });
          continue;
        }

        // Update each matched entity with 8821 completion data
        for (const entity of entities) {
          const updateData: Record<string, unknown> = {
            status: 'irs_queue', // 8821 complete → ready for expert
          };

          if (row.signer_first_name) updateData.signer_first_name = row.signer_first_name;
          if (row.signer_last_name) updateData.signer_last_name = row.signer_last_name;
          if (row.signer_email) updateData.signer_email = row.signer_email;
          if (row.signature_date) {
            updateData.signature_created_at = parseSignatureDate(row.signature_date);
          }

          const { error: updateErr } = await supabase
            .from('request_entities')
            .update(updateData)
            .eq('id', entity.id);

          if (updateErr) {
            results.push({
              row: i + 1,
              request_token: row.request_token,
              entity_name: entity.entity_name,
              entity_id: entity.id,
              status: 'error',
              message: updateErr.message,
            });
          } else {
            results.push({
              row: i + 1,
              request_token: row.request_token,
              entity_name: entity.entity_name,
              entity_id: entity.id,
              status: 'updated',
            });
          }
        }
      } catch (rowErr) {
        results.push({
          row: i + 1,
          request_token: row.request_token,
          entity_name: row.entity_name,
          status: 'error',
          message: rowErr instanceof Error ? rowErr.message : 'Unknown error',
        });
      }
    }

    const updated = results.filter((r) => r.status === 'updated').length;
    const notFound = results.filter((r) => r.status === 'not_found').length;
    const errored = results.filter((r) => r.status === 'error').length;

    // --- Audit ---
    await logAuditFromRequest(supabase, request, {
      action: '8821_data_uploaded',
      resourceType: 'batch',
      resourceId: client.id,
      details: {
        client_name: client.name,
        rows_processed: rows.length,
        updated,
        not_found: notFound,
        errors: errored,
      },
    });

    return NextResponse.json({
      success: true,
      summary: {
        rows_processed: rows.length,
        updated,
        not_found: notFound,
        errors: errored,
      },
      results,
    });
  } catch (err) {
    console.error('[8821-upload] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '8821 data upload failed' },
      { status: 500 }
    );
  }
}
