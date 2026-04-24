import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import { validateFormTypeMatchesTidKind } from '@/lib/form-type-validation';

/**
 * Parse a free-form years string from the upload form into a normalized
 * sorted array of YYYY strings. Returns null on invalid input.
 *
 * Accepts the same formats the Processor8821Panel UI accepts:
 *   - "2021,2022,2023"  (comma list, possibly with spaces)
 *   - "2021-2024"       (range, expanded inclusive)
 *   - "2019, 2021-2023" (mixed)
 *   - "2023"            (single year)
 *
 * Or, if the caller passes a JSON-encoded array (PATCH path), returns it
 * after light validation.
 */
function parseYearsField(input: string | string[] | null): string[] | null {
  if (!input) return null;
  if (Array.isArray(input)) {
    const cleaned = input
      .map(y => String(y).trim())
      .filter(y => /^\d{4}$/.test(y));
    return cleaned.length > 0 ? Array.from(new Set(cleaned)).sort() : null;
  }
  const out = new Set<string>();
  const currentYear = new Date().getFullYear();
  const tokens = input.split(/[,;\n]+/).map(t => t.trim()).filter(Boolean);
  for (const token of tokens) {
    const range = token.match(/^(\d{4})\s*[-–—to]+\s*(\d{4})$/i);
    if (range) {
      const a = parseInt(range[1], 10);
      const b = parseInt(range[2], 10);
      if (a > b || a < 1990 || b > currentYear + 1) return null;
      for (let y = a; y <= b; y++) out.add(String(y));
      continue;
    }
    const single = token.match(/^(\d{4})$/);
    if (single) {
      const y = parseInt(single[1], 10);
      if (y < 1990 || y > currentYear + 1) return null;
      out.add(String(y));
      continue;
    }
    return null;
  }
  return out.size > 0 ? Array.from(out).sort() : null;
}

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('role, client_id')
      .eq('id', user.id)
      .single() as { data: { role: string; client_id: string | null } | null; error: any };

    if (!profile || !['admin', 'processor', 'manager'].includes(profile.role)) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const formData = await request.formData();
    const entityId = formData.get('entityId') as string | null;
    const file = formData.get('file') as File | null;
    const yearsRaw = formData.get('years') as string | null;
    const formTypeRaw = formData.get('formType') as string | null;

    if (!entityId || !file) {
      return NextResponse.json(
        { error: 'entityId and file are required' },
        { status: 400 }
      );
    }

    // Validate file type
    if (!file.name.endsWith('.pdf')) {
      return NextResponse.json(
        { error: 'Only PDF files are accepted for 8821 forms' },
        { status: 400 }
      );
    }

    // Years are required at upload time — without them the IRS expert has no idea
    // which periods to request from PPS. The Processor8821Panel enforces this on the
    // client; we re-enforce here so direct API hits can't bypass it.
    const years = parseYearsField(yearsRaw);
    if (!years || years.length === 0) {
      return NextResponse.json(
        { error: 'years field is required (e.g. "2021,2022,2023" or "2021-2024")' },
        { status: 400 }
      );
    }

    // formType defaults to existing entity value, but must be a valid 8821 form code
    const validForms = ['1040', '1065', '1120', '1120S'];
    const formType = formTypeRaw && validForms.includes(formTypeRaw) ? formTypeRaw : null;

    const adminSupabase = createAdminClient();

    // Verify entity exists
    const { data: entity } = await adminSupabase
      .from('request_entities')
      .select('id, entity_name, request_id, status, tid_kind')
      .eq('id', entityId)
      .single() as { data: any; error: any };

    // If formType is being changed, verify it matches tid_kind on the entity —
    // blocks an EIN business from being stamped 1040 or an SSN individual from
    // being stamped 1120S.
    if (formType && entity?.tid_kind) {
      const mismatch = validateFormTypeMatchesTidKind(entity.tid_kind, formType);
      if (mismatch) {
        return NextResponse.json({ error: mismatch }, { status: 400 });
      }
    }

    if (!entity) {
      return NextResponse.json({ error: 'Entity not found' }, { status: 404 });
    }

    // For non-admins, verify entity belongs to their client
    if (profile.role !== 'admin' && profile.client_id) {
      const { data: req } = await adminSupabase
        .from('requests')
        .select('client_id')
        .eq('id', entity.request_id)
        .single() as { data: any; error: any };

      if (!req || req.client_id !== profile.client_id) {
        return NextResponse.json({ error: 'Not authorized for this entity' }, { status: 403 });
      }
    }

    // Upload file to Supabase storage
    const buffer = Buffer.from(await file.arrayBuffer());
    const filePath = `8821/${entityId}/${Date.now()}-signed-8821.pdf`;

    const { error: uploadError } = await adminSupabase.storage
      .from('uploads')
      .upload(filePath, buffer, {
        contentType: 'application/pdf',
        upsert: false,
      });

    if (uploadError) {
      console.error('8821 upload error:', uploadError);
      return NextResponse.json(
        { error: 'Failed to upload file' },
        { status: 500 }
      );
    }

    // Update entity with signed_8821_url, years, form_type, and auto-advance status
    const updateFields: Record<string, unknown> = {
      signed_8821_url: filePath,
      years,
    };
    if (formType) updateFields.form_type = formType;
    if (['pending', 'submitted', '8821_sent'].includes(entity.status)) {
      updateFields.status = '8821_signed';
    }

    const { error: updateError } = await adminSupabase
      .from('request_entities')
      .update(updateFields)
      .eq('id', entityId);

    if (updateError) {
      console.error('Failed to update entity:', updateError);
      return NextResponse.json(
        { error: 'Failed to update entity record' },
        { status: 500 }
      );
    }

    // Audit log
    await logAuditFromRequest(adminSupabase, request, {
      action: 'file_uploaded',
      userId: user.id,
      userEmail: user.email || '',
      resourceType: 'request_entity',
      resourceId: entityId,
      details: {
        action: '8821_uploaded',
        entity_name: entity.entity_name,
        file_path: filePath,
        request_id: entity.request_id,
      },
    });

    return NextResponse.json({
      success: true,
      filePath,
      entityName: entity.entity_name,
    });
  } catch (error) {
    console.error('8821 upload error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 }
    );
  }
}

/**
 * PATCH — update entity metadata (years, formType) without re-uploading the 8821.
 *
 * This exists for the case where a signed 8821 was uploaded but years and/or
 * form_type were never set (intake bug or processor oversight). Lets the
 * processor backfill the entity from the same panel without forcing them to
 * replace the file.
 */
export async function PATCH(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('role, client_id')
      .eq('id', user.id)
      .single() as { data: { role: string; client_id: string | null } | null; error: any };

    if (!profile || !['admin', 'processor', 'manager'].includes(profile.role)) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const body = await request.json();
    const entityId = typeof body?.entityId === 'string' ? body.entityId : null;
    const yearsInput = body?.years ?? null;
    const formTypeRaw = typeof body?.formType === 'string' ? body.formType : null;

    if (!entityId) {
      return NextResponse.json({ error: 'entityId required' }, { status: 400 });
    }

    const years = parseYearsField(yearsInput);
    if (!years || years.length === 0) {
      return NextResponse.json(
        { error: 'years must be provided (array or "2021,2022,2023" / "2021-2024")' },
        { status: 400 }
      );
    }

    const validForms = ['1040', '1065', '1120', '1120S'];
    const formType = formTypeRaw && validForms.includes(formTypeRaw) ? formTypeRaw : null;

    const adminSupabase = createAdminClient();

    // Verify entity + access (same checks as POST)
    const { data: entity } = await adminSupabase
      .from('request_entities')
      .select('id, entity_name, request_id, status, years, form_type, tid_kind')
      .eq('id', entityId)
      .single() as { data: any; error: any };

    if (!entity) {
      return NextResponse.json({ error: 'Entity not found' }, { status: 404 });
    }

    // Form-type vs tid_kind compatibility — same rule as POST. Blocks silent
    // backfill that would set an EIN entity's form to 1040 or vice versa.
    if (formType && entity.tid_kind) {
      const mismatch = validateFormTypeMatchesTidKind(entity.tid_kind, formType);
      if (mismatch) {
        return NextResponse.json({ error: mismatch }, { status: 400 });
      }
    }

    if (profile.role !== 'admin' && profile.client_id) {
      const { data: req } = await adminSupabase
        .from('requests')
        .select('client_id')
        .eq('id', entity.request_id)
        .single() as { data: any; error: any };

      if (!req || req.client_id !== profile.client_id) {
        return NextResponse.json({ error: 'Not authorized for this entity' }, { status: 403 });
      }
    }

    const updateFields: Record<string, unknown> = { years };
    if (formType) updateFields.form_type = formType;

    const { error: updateError } = await adminSupabase
      .from('request_entities')
      .update(updateFields)
      .eq('id', entityId);

    if (updateError) {
      console.error('Failed to update entity metadata:', updateError);
      return NextResponse.json(
        { error: 'Failed to update entity record' },
        { status: 500 }
      );
    }

    await logAuditFromRequest(adminSupabase, request, {
      action: 'entity_metadata_updated',
      userId: user.id,
      userEmail: user.email || '',
      resourceType: 'request_entity',
      resourceId: entityId,
      details: {
        entity_name: entity.entity_name,
        request_id: entity.request_id,
        previous_years: entity.years,
        new_years: years,
        previous_form_type: entity.form_type,
        new_form_type: formType,
      },
    });

    return NextResponse.json({
      success: true,
      entityName: entity.entity_name,
      years,
      formType: formType || entity.form_type,
    });
  } catch (error) {
    console.error('Entity metadata update error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Update failed' },
      { status: 500 }
    );
  }
}
