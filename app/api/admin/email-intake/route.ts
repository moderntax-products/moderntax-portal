/**
 * Email Intake API Route
 * Allows admin to submit a CSV on behalf of a user (email-to-portal agent)
 * POST /api/admin/email-intake
 *
 * Accepts multipart form data:
 *   - file: CSV/Excel file
 *   - sender_email: The email of the user this request is on behalf of
 *   - loan_number: Loan/application number
 *   - notes: (optional) Notes for the request
 *
 * This creates the request as if the user submitted it through the portal,
 * including proper audit trail noting it was submitted via email intake.
 */

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
  years: string;
  form: string;
}

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
    years: normalized['years'] || normalized['year'] || '',
    form: normalized['form'] || normalized['form_type'] || normalized['formtype'] || '1040',
  };
}

function validateFormType(form: string): string {
  // Take only the part before the first comma (e.g., "1120-S, tax transcripts" → "1120-S")
  const formPart = form.split(',')[0].trim();
  // Strip whitespace, hyphens, and normalize
  const normalized = formPart.replace(/[\s-]/g, '').toUpperCase();
  const valid = ['1040', '1065', '1120', '1120S'];
  if (valid.includes(normalized)) return normalized;
  // Try matching with "FORM" prefix stripped
  const stripped = normalized.replace('FORM', '');
  if (valid.includes(stripped)) return stripped;
  return '1040';
}

function parseSignatureDate(raw: string): string | null {
  if (!raw) return null;
  // Handle Excel serial date numbers (e.g., 46063 = 2/10/2026)
  const num = Number(raw);
  if (!isNaN(num) && num > 40000 && num < 60000) {
    const excelEpoch = new Date(1899, 11, 30); // Excel epoch
    const date = new Date(excelEpoch.getTime() + num * 86400000);
    return date.toISOString();
  }
  // Try parsing as a date string
  const parsed = new Date(raw);
  if (!isNaN(parsed.getTime())) return parsed.toISOString();
  return null;
}

function parseYears(years: string): string[] {
  if (!years) return [];
  const cleaned = years.replace(/[{}'"]/g, '');
  return cleaned
    .split(/[,;\s]+/)
    .map((y) => y.trim())
    .filter((y) => /^\d{4}$/.test(y));
}

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);

    // Verify caller is admin
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
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    // Parse form data
    const formData = await request.formData();
    const mode = (formData.get('mode') as string) || 'csv';
    const senderEmail = formData.get('sender_email') as string | null;
    const loanNumber = formData.get('loan_number') as string | null;
    const notes = formData.get('notes') as string | null;

    if (!senderEmail?.trim()) {
      return NextResponse.json({ error: 'sender_email is required' }, { status: 400 });
    }

    if (!loanNumber?.trim()) {
      return NextResponse.json({ error: 'loan_number is required' }, { status: 400 });
    }

    // Look up the sender by email to find their profile
    const adminSupabase = createAdminClient();
    const { data: senderProfile } = await adminSupabase
      .from('profiles')
      .select('id, email, full_name, role, client_id')
      .eq('email', senderEmail.trim().toLowerCase())
      .single() as { data: any; error: any };

    if (!senderProfile) {
      return NextResponse.json(
        { error: `No user found with email: ${senderEmail}. They must have a portal account first.` },
        { status: 404 }
      );
    }

    if (!senderProfile.client_id) {
      return NextResponse.json(
        { error: `User ${senderEmail} has no client associated` },
        { status: 400 }
      );
    }

    const effectiveLoanNumber = loanNumber!.trim();

    // Get client name for notifications
    const { data: clientData } = await adminSupabase
      .from('clients')
      .select('name')
      .eq('id', senderProfile.client_id)
      .single() as { data: { name: string } | null; error: any };

    if (mode === 'manual') {
      return handleManualIntake(request, formData, adminSupabase, user, senderProfile, effectiveLoanNumber, notes, clientData);
    }

    return handleCsvIntake(request, formData, adminSupabase, user, senderProfile, effectiveLoanNumber, notes, clientData);
  } catch (err) {
    console.error('Email intake error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Email intake failed' },
      { status: 500 }
    );
  }
}

async function handleManualIntake(
  request: NextRequest,
  formData: FormData,
  adminSupabase: ReturnType<typeof createAdminClient>,
  user: { id: string; email?: string },
  senderProfile: any,
  loanNumber: string,
  notes: string | null,
  clientData: { name: string } | null
) {
  const entityName = formData.get('entity_name') as string | null;
  const tid = formData.get('tid') as string | null;
  const tidKind = (formData.get('tid_kind') as string) || 'EIN';
  const formType = formData.get('form_type') as string | null;
  const years = formData.get('years') as string | null;
  const pdfFile = formData.get('file') as File | null;

  if (!entityName?.trim()) {
    return NextResponse.json({ error: 'entity_name is required' }, { status: 400 });
  }
  if (!tid?.trim()) {
    return NextResponse.json({ error: 'tid (EIN/SSN) is required' }, { status: 400 });
  }
  if (!years?.trim()) {
    return NextResponse.json({ error: 'years is required' }, { status: 400 });
  }

  const parsedYears = parseYears(years);
  if (parsedYears.length === 0) {
    return NextResponse.json({ error: 'No valid years provided' }, { status: 400 });
  }

  // Upload 8821 PDF if provided
  let signed8821Url: string | null = null;
  if (pdfFile && pdfFile.name.endsWith('.pdf')) {
    const pdfBuffer = Buffer.from(await pdfFile.arrayBuffer());
    const pdfPath = `${senderProfile.client_id}/${Date.now()}-email-intake-8821-${pdfFile.name}`;
    const { error: uploadError } = await adminSupabase.storage
      .from('uploads')
      .upload(pdfPath, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: false,
      });
    if (!uploadError) {
      signed8821Url = pdfPath;
    }
  }

  // Create request
  const { data: req, error: reqError } = await adminSupabase
    .from('requests')
    .insert({
      client_id: senderProfile.client_id,
      requested_by: senderProfile.id,
      loan_number: loanNumber,
      intake_method: 'pdf',
      status: 'submitted',
      notes: notes
        ? `[Via email intake by admin] ${notes}`
        : '[Submitted via email intake]',
    })
    .select()
    .single() as { data: { id: string } | null; error: unknown };

  if (reqError || !req) {
    console.error('Request creation error:', reqError);
    return NextResponse.json({ error: 'Failed to create request' }, { status: 500 });
  }

  // Create entity
  const { error: entError } = await adminSupabase.from('request_entities').insert({
    request_id: req.id,
    entity_name: entityName.trim(),
    tid: tid.trim(),
    tid_kind: ['SSN', 'ITIN'].includes(tidKind.toUpperCase()) ? 'SSN' : 'EIN',
    form_type: validateFormType(formType || '1040'),
    years: parsedYears,
    signed_8821_url: signed8821Url,
    status: signed8821Url ? '8821_signed' : 'pending',
  });

  if (entError) {
    console.error('Entity creation error:', entError);
  }

  // Audit log
  await logAuditFromRequest(adminSupabase, request, {
    action: 'file_uploaded',
    userId: user.id,
    userEmail: user.email || '',
    resourceType: 'request',
    resourceId: req.id,
    details: {
      intake_method: 'email_intake_manual',
      entity_name: entityName.trim(),
      entity_count: entError ? 0 : 1,
      request_id: req.id,
      loan_number: loanNumber,
      has_8821: !!signed8821Url,
      on_behalf_of: senderProfile.email,
      on_behalf_of_name: senderProfile.full_name,
      client_name: clientData?.name,
    },
  });

  return NextResponse.json({
    success: true,
    request_id: req.id,
    entities_created: entError ? 0 : 1,
    loan_number: loanNumber,
    on_behalf_of: {
      email: senderProfile.email,
      name: senderProfile.full_name,
      role: senderProfile.role,
      client: clientData?.name,
    },
    message: `Request created for ${senderProfile.full_name} (${senderProfile.email}) at ${clientData?.name || 'Unknown'}`,
  });
}

async function handleCsvIntake(
  request: NextRequest,
  formData: FormData,
  adminSupabase: ReturnType<typeof createAdminClient>,
  user: { id: string; email?: string },
  senderProfile: any,
  loanNumber: string,
  notes: string | null,
  clientData: { name: string } | null
) {
  const file = formData.get('file') as File | null;

  if (!file) {
    return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
  }

  // Read and parse CSV/Excel
  const buffer = Buffer.from(await file.arrayBuffer());
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);

  if (rawRows.length === 0) {
    return NextResponse.json({ error: 'File contains no data rows' }, { status: 400 });
  }

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
  const filePath = `${senderProfile.client_id}/${Date.now()}-email-intake-${file.name}`;
  const { error: uploadError } = await adminSupabase.storage
    .from('uploads')
    .upload(filePath, buffer, {
      contentType: file.type,
      upsert: false,
    });

  const sourceFileUrl = uploadError ? null : filePath;

  // Create batch as the sender
  const { data: batch, error: batchError } = await adminSupabase
    .from('batches')
    .insert({
      client_id: senderProfile.client_id,
      uploaded_by: senderProfile.id,
      intake_method: 'csv',
      source_file_url: sourceFileUrl,
      original_filename: file.name,
      entity_count: rows.length,
      request_count: 1,
      status: 'completed',
    })
    .select()
    .single() as { data: { id: string } | null; error: unknown };

  if (batchError || !batch) {
    console.error('Batch creation error:', batchError);
    return NextResponse.json({ error: 'Failed to create batch' }, { status: 500 });
  }

  // Create request attributed to the sender
  const { data: req, error: reqError } = await adminSupabase
    .from('requests')
    .insert({
      client_id: senderProfile.client_id,
      requested_by: senderProfile.id,
      batch_id: batch.id,
      loan_number: loanNumber,
      intake_method: 'csv',
      status: 'submitted',
      notes: notes
        ? `[Via email intake by admin] ${notes}`
        : '[Submitted via email intake]',
    })
    .select()
    .single() as { data: { id: string } | null; error: unknown };

  if (reqError || !req) {
    console.error('Request creation error:', reqError);
    return NextResponse.json({ error: 'Failed to create request' }, { status: 500 });
  }

  // Create entities
  const entities = rows.map((row) => ({
    request_id: req.id,
    entity_name: row.legal_name,
    tid: row.tid,
    tid_kind: ['SSN', 'ITIN'].includes(row.tid_kind?.toUpperCase()) ? 'SSN' : 'EIN',
    address: row.address || null,
    city: row.city || null,
    state: row.state || null,
    zip_code: row.zip_code || null,
    form_type: validateFormType(row.form),
    years: parseYears(row.years),
    signer_first_name: row['first name'] || null,
    signer_last_name: row['last name'] || null,
    signature_id: row.signature_id || null,
    signature_created_at: parseSignatureDate(row.signature_created_at),
    status: row.signature_id ? '8821_signed' : 'pending',
  }));

  const { error: entError } = await adminSupabase.from('request_entities').insert(entities);
  const entityCount = entError ? 0 : entities.length;

  if (entError) {
    console.error('Entity creation error:', entError);
  }

  // Audit log
  await logAuditFromRequest(adminSupabase, request, {
    action: 'file_uploaded',
    userId: user.id,
    userEmail: user.email || '',
    resourceType: 'batch',
    resourceId: batch.id,
    details: {
      intake_method: 'email_intake',
      filename: file.name,
      entity_count: entityCount,
      request_id: req.id,
      loan_number: loanNumber,
      on_behalf_of: senderProfile.email,
      on_behalf_of_name: senderProfile.full_name,
      client_name: clientData?.name,
    },
  });

  return NextResponse.json({
    success: true,
    batch_id: batch.id,
    request_id: req.id,
    entities_created: entityCount,
    loan_number: loanNumber,
    on_behalf_of: {
      email: senderProfile.email,
      name: senderProfile.full_name,
      role: senderProfile.role,
      client: clientData?.name,
    },
    message: `Request created for ${senderProfile.full_name} (${senderProfile.email}) at ${clientData?.name || 'Unknown'}`,
  });
}
