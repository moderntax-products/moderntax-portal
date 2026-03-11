import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';

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

    // Parse form data
    const formData = await request.formData();
    const loanNumber = formData.get('loan_number') as string | null;
    const entityName = formData.get('entity_name') as string | null;
    const tid = formData.get('tid') as string | null;
    const tidKind = (formData.get('tid_kind') as string) || 'EIN';
    const formType = (formData.get('form_type') as string) || '1040';
    const years = formData.get('years') as string | null;
    const notes = formData.get('notes') as string | null;

    // Get all PDF files
    const files: File[] = [];
    for (const [key, value] of formData.entries()) {
      if (key === 'files' && value instanceof File) {
        files.push(value);
      }
    }

    if (files.length === 0) {
      return NextResponse.json({ error: 'No PDF files uploaded' }, { status: 400 });
    }

    if (!loanNumber?.trim()) {
      return NextResponse.json({ error: 'Loan number is required' }, { status: 400 });
    }

    if (!entityName?.trim()) {
      return NextResponse.json({ error: 'Entity name is required' }, { status: 400 });
    }

    if (!tid?.trim()) {
      return NextResponse.json({ error: 'Tax ID is required' }, { status: 400 });
    }

    const admin = createAdminClient();

    // Create batch
    const { data: batch, error: batchError } = (await supabase
      .from('batches')
      .insert({
        client_id: profile.client_id,
        uploaded_by: user.id,
        intake_method: 'pdf',
        entity_count: files.length,
        request_count: 1,
        status: 'completed',
      })
      .select()
      .single()) as { data: { id: string } | null; error: unknown };

    if (batchError || !batch) {
      console.error('Batch creation error:', batchError);
      return NextResponse.json({ error: 'Failed to create batch' }, { status: 500 });
    }

    // Create request
    const { data: req, error: reqError } = (await supabase
      .from('requests')
      .insert({
        client_id: profile.client_id,
        requested_by: user.id,
        batch_id: batch.id,
        loan_number: loanNumber.trim(),
        intake_method: 'pdf',
        status: '8821_signed', // PDFs are already signed
        notes: notes || null,
      })
      .select()
      .single()) as { data: { id: string } | null; error: unknown };

    if (reqError || !req) {
      console.error('Request creation error:', reqError);
      return NextResponse.json({ error: 'Failed to create request' }, { status: 500 });
    }

    // Upload PDFs and create entities
    const parsedYears = years
      ? years
          .split(/[,;\s]+/)
          .map((y) => y.trim())
          .filter((y) => /^\d{4}$/.test(y))
      : ['2024'];

    let entityCount = 0;

    for (const file of files) {
      const buffer = Buffer.from(await file.arrayBuffer());
      const filePath = `${profile.client_id}/8821/${Date.now()}-${file.name}`;

      // Upload to storage
      const { error: uploadError } = await admin.storage
        .from('uploads')
        .upload(filePath, buffer, {
          contentType: 'application/pdf',
          upsert: false,
        });

      if (uploadError) {
        console.error('PDF upload error:', uploadError);
        continue;
      }

      // Create entity
      const { error: entError } = await supabase.from('request_entities').insert({
        request_id: req.id,
        entity_name: entityName.trim(),
        tid: tid.trim(),
        tid_kind: tidKind.toUpperCase() === 'SSN' ? 'SSN' : 'EIN',
        form_type: formType,
        years: parsedYears,
        signed_8821_url: filePath,
        status: '8821_signed',
      });

      if (entError) {
        console.error('Entity creation error:', entError);
      } else {
        entityCount++;
      }
    }

    // Audit log: PDF upload completed
    await logAuditFromRequest(supabase, request, {
      action: 'file_uploaded',
      resourceType: 'batch',
      resourceId: batch.id,
      details: {
        intake_method: 'pdf',
        file_count: files.length,
        entity_count: entityCount,
        request_id: req.id,
        loan_number: loanNumber!.trim(),
      },
    });

    return NextResponse.json({
      success: true,
      batch_id: batch.id,
      request_id: req.id,
      entities_created: entityCount,
    });
  } catch (err) {
    console.error('PDF upload error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Upload failed' },
      { status: 500 }
    );
  }
}
