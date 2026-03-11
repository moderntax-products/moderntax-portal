import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import * as XLSX from 'xlsx';

interface CsvRow {
  legal_name: string;
  tid: string;
  tid_kind: string;
  address: string;
  city: string;
  state: string;
  zip_code: string;
  signature_id: string;
  'first name': string;
  'last name': string;
  signature_created_at: string;
  credit_application_id: string;
  years: string;
  form: string;
}

// Normalize column headers to handle case/spacing variations
function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, '_');
}

function mapRow(raw: Record<string, unknown>): CsvRow {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    normalized[normalizeHeader(key)] = String(value ?? '').trim();
  }

  return {
    legal_name: normalized['legal_name'] || normalized['legalname'] || '',
    tid: normalized['tid'] || '',
    tid_kind: normalized['tid_kind'] || normalized['tidkind'] || 'EIN',
    address: normalized['address'] || '',
    city: normalized['city'] || '',
    state: normalized['state'] || '',
    zip_code: normalized['zip_code'] || normalized['zipcode'] || normalized['zip'] || '',
    signature_id: normalized['signature_id'] || normalized['signatureid'] || '',
    'first name': normalized['first_name'] || normalized['firstname'] || '',
    'last name': normalized['last_name'] || normalized['lastname'] || '',
    signature_created_at: normalized['signature_created_at'] || normalized['signaturecreatedat'] || '',
    credit_application_id:
      normalized['credit_application_id'] ||
      normalized['creditapplicationid'] ||
      normalized['loan_number'] ||
      normalized['loannumber'] ||
      normalized['loan_#'] ||
      normalized['loan#'] ||
      '',
    years: normalized['years'] || normalized['year'] || '',
    form: normalized['form'] || normalized['form_type'] || normalized['formtype'] || '1040',
  };
}

function validateFormType(form: string): string {
  const normalized = form.replace(/\s/g, '').toUpperCase();
  const valid = ['1040', '1065', '1120', '1120S'];
  if (valid.includes(normalized)) return normalized;
  // Try matching with "FORM " prefix
  const stripped = normalized.replace('FORM', '');
  if (valid.includes(stripped)) return stripped;
  return '1040'; // default
}

function parseYears(years: string): string[] {
  if (!years) return [];
  // Strip Postgres array braces {2022,2023} and quotes
  const cleaned = years.replace(/[{}'"]/g, '');
  // Handle comma-separated, space-separated, or single year
  return cleaned
    .split(/[,;\s]+/)
    .map((y) => y.trim())
    .filter((y) => /^\d{4}$/.test(y));
}

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);

    // Check auth
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get profile
    const { data: profile } = (await supabase
      .from('profiles')
      .select('client_id')
      .eq('id', user.id)
      .single()) as { data: { client_id: string | null } | null; error: unknown };

    if (!profile?.client_id) {
      return NextResponse.json({ error: 'No client associated' }, { status: 400 });
    }

    // Parse multipart form data
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const loanNumber = formData.get('loan_number') as string | null;
    const notes = formData.get('notes') as string | null;

    if (!file) {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    }

    if (!loanNumber?.trim()) {
      return NextResponse.json({ error: 'Loan number is required' }, { status: 400 });
    }

    // Read file as buffer
    const buffer = Buffer.from(await file.arrayBuffer());

    // Parse with SheetJS
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);

    if (rawRows.length === 0) {
      return NextResponse.json({ error: 'File contains no data rows' }, { status: 400 });
    }

    // Map and validate rows
    const rows = rawRows.map(mapRow);
    const errors: string[] = [];

    rows.forEach((row, idx) => {
      if (!row.legal_name) errors.push(`Row ${idx + 2}: missing legal_name`);
      if (!row.tid) errors.push(`Row ${idx + 2}: missing tid`);
    });

    if (errors.length > 0) {
      return NextResponse.json(
        { error: 'Validation errors', details: errors.slice(0, 10) },
        { status: 400 }
      );
    }

    // Upload source file to storage
    const admin = createAdminClient();
    const filePath = `${profile.client_id}/${Date.now()}-${file.name}`;
    const { error: uploadError } = await admin.storage
      .from('uploads')
      .upload(filePath, buffer, {
        contentType: file.type,
        upsert: false,
      });

    const sourceFileUrl = uploadError ? null : filePath;

    // Use the loan number from the form — all entities go under one request
    const effectiveLoanNumber = loanNumber!.trim();

    // Create batch
    const { data: batch, error: batchError } = (await supabase
      .from('batches')
      .insert({
        client_id: profile.client_id,
        uploaded_by: user.id,
        intake_method: 'csv',
        source_file_url: sourceFileUrl,
        original_filename: file.name,
        entity_count: rows.length,
        request_count: 1,
        status: 'completed',
      })
      .select()
      .single()) as { data: { id: string } | null; error: unknown };

    if (batchError || !batch) {
      console.error('Batch creation error:', batchError);
      return NextResponse.json({ error: 'Failed to create batch' }, { status: 500 });
    }

    // Create single request with the user-provided loan number
    const { data: req, error: reqError } = (await supabase
      .from('requests')
      .insert({
        client_id: profile.client_id,
        requested_by: user.id,
        batch_id: batch.id,
        loan_number: effectiveLoanNumber,
        intake_method: 'csv',
        status: 'submitted',
        notes: notes || null,
      })
      .select()
      .single()) as { data: { id: string } | null; error: unknown };

    if (reqError || !req) {
      console.error('Request creation error:', reqError);
      return NextResponse.json({ error: 'Failed to create request' }, { status: 500 });
    }

    // Create entities from CSV rows
    const entities = rows.map((row) => ({
      request_id: req.id,
      entity_name: row.legal_name,
      tid: row.tid,
      tid_kind: row.tid_kind?.toUpperCase() === 'SSN' ? 'SSN' : 'EIN',
      address: row.address || null,
      city: row.city || null,
      state: row.state || null,
      zip_code: row.zip_code || null,
      form_type: validateFormType(row.form),
      years: parseYears(row.years),
      signer_first_name: row['first name'] || null,
      signer_last_name: row['last name'] || null,
      signature_id: row.signature_id || null,
      signature_created_at: row.signature_created_at || null,
      status: row.signature_id ? '8821_signed' : 'pending',
    }));

    const { error: entError } = await supabase.from('request_entities').insert(entities);
    const entityCount = entError ? 0 : entities.length;

    if (entError) {
      console.error('Entity creation error:', entError);
    }

    // Audit log: CSV upload completed
    await logAuditFromRequest(supabase, request, {
      action: 'file_uploaded',
      resourceType: 'batch',
      resourceId: batch.id,
      details: {
        intake_method: 'csv',
        filename: file.name,
        entity_count: entityCount,
        request_id: req.id,
        loan_number: effectiveLoanNumber,
      },
    });

    return NextResponse.json({
      success: true,
      batch_id: batch.id,
      request_id: req.id,
      requests_created: 1,
      entities_created: entityCount,
      loan_numbers: [effectiveLoanNumber],
    });
  } catch (err) {
    console.error('CSV upload error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Upload failed' },
      { status: 500 }
    );
  }
}
