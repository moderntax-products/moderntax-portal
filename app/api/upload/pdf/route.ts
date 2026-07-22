import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import { sendAdminNewRequestNotification, sendManagerEntityTranscriptNotification } from '@/lib/sendgrid';
import { RATE_ENTITY_TRANSCRIPT } from '@/lib/clients';
import { resolveFormType } from '@/lib/form-type-validation';
import { autoPostIntakeNote } from '@/lib/intake-note-autopost';
import { extractTaxpayerInfoFrom8821, normalizeTin } from '@/lib/extract-8821-pdf';
import { autoGenerate8821sForRequest } from '@/lib/8821-autogen';

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
      .select('client_id, full_name, role')
      .eq('id', user.id)
      .single()) as { data: { client_id: string | null; full_name: string | null; role: string } | null; error: unknown };

    if (!profile?.client_id) {
      return NextResponse.json({ error: 'No client associated' }, { status: 400 });
    }

    // Order gate — same trial+payment-method enforcement as CSV intake. 402
    // when blocked so the client gets a clear "add payment method" CTA.
    const { checkOrderGate, buildOrderGateErrorBody } = await import('@/lib/order-gate');
    const adminForGate = createAdminClient();
    const gate = await checkOrderGate(adminForGate, profile.client_id);
    if (!gate.allowed) {
      return NextResponse.json(buildOrderGateErrorBody(gate), { status: gate.status || 402 });
    }

    // Get client name for notifications
    const { data: clientRecord } = await supabase
      .from('clients')
      .select('name')
      .eq('id', profile.client_id)
      .single() as { data: { name: string } | null; error: any };
    const clientName = clientRecord?.name || 'Unknown';

    // Parse form data
    const formData = await request.formData();
    const loanNumber = formData.get('loan_number') as string | null;
    const entityName = formData.get('entity_name') as string | null;
    const tid = formData.get('tid') as string | null;
    const tidKind = (formData.get('tid_kind') as string) || 'EIN';
    const rawFormType = formData.get('form_type') as string | null;
    const years = formData.get('years') as string | null;
    const notes = formData.get('notes') as string | null;
    // Taxpayer contact + mailing address — now REQUIRED on the upload form so we
    // don't depend on parsing them off the (often scanned/illegible) 8821.
    const signerFirstName = (formData.get('signer_first_name') as string | null)?.trim() || '';
    const signerLastName = (formData.get('signer_last_name') as string | null)?.trim() || '';
    const signerEmail = (formData.get('signer_email') as string | null)?.trim() || '';
    const tpAddress = (formData.get('address') as string | null)?.trim() || '';
    const tpCity = (formData.get('city') as string | null)?.trim() || '';
    const tpState = (formData.get('state') as string | null)?.trim() || '';
    const tpZip = (formData.get('zip_code') as string | null)?.trim() || '';
    const entityTranscriptRequested = formData.get('entity_transcript') === 'true';
    // Fiscal year end month (1-11). NULL = calendar year. Accepts "2",
    // "Feb", "February", "2/28", or "02-28". See parseFyeMonthFromFormData.
    const rawFye = formData.get('fiscal_year_end_month') as string | null
      || formData.get('fye_month') as string | null
      || formData.get('fye') as string | null;
    const fiscalYearEndMonth = parseFyeMonthFromFormData(rawFye);

    // Resolve form_type against tid_kind — rejects EIN→1040 and SSN→1120 mismatches.
    const resolved = resolveFormType(rawFormType, tidKind);
    if (resolved.error) {
      return NextResponse.json({ error: resolved.error }, { status: 400 });
    }
    const formType = resolved.formType as string;

    // Get all PDF files
    const files: File[] = [];
    for (const [key, value] of formData.entries()) {
      if (key === 'files' && value instanceof File) {
        files.push(value);
      }
    }

    // Files the browser already put in storage via /api/upload/sign-8821.
    // Vercel caps a function request body at ~4.5 MB at the platform edge, so
    // a scanned 8821 sent through this route as multipart never arrived — the
    // client got an opaque 413 it couldn't even parse. The browser now uploads
    // straight to Supabase Storage (50 MB bucket limit) and sends only paths.
    // Both shapes are accepted: `files` still works for small/legacy callers.
    let uploadedPaths: string[] = [];
    const rawPaths = formData.get('uploaded_paths');
    if (typeof rawPaths === 'string' && rawPaths.trim()) {
      try {
        const parsed = JSON.parse(rawPaths);
        if (Array.isArray(parsed)) {
          // Only accept paths inside this client's own prefix — the signing
          // route assigns them, so anything else is a forged or stale value.
          uploadedPaths = parsed
            .filter((p): p is string => typeof p === 'string')
            .filter((p) => p.startsWith(`${profile.client_id}/8821/`));
        }
      } catch {
        return NextResponse.json({ error: 'Malformed uploaded_paths' }, { status: 400 });
      }
    }

    // NOTE: a missing PDF is deliberately NOT an error. Processors routinely
    // reach this screen needing an 8821 they don't have yet — most often the
    // personal 1040 of a guarantor on a loan whose business 8821 is already
    // signed. Rejecting the submission stranded the order entirely (the
    // processor had to email an admin), so we now capture the order and
    // generate a pre-filled 8821 for signature instead. Per Matt 2026-07-21:
    // always take the order, surface the gap afterwards — never block intake.
    const hasSignedPdf = files.length > 0 || uploadedPaths.length > 0;

    if (!loanNumber?.trim()) {
      return NextResponse.json({ error: 'Loan number is required' }, { status: 400 });
    }

    if (!entityName?.trim()) {
      return NextResponse.json({ error: 'Entity name is required' }, { status: 400 });
    }

    if (!tid?.trim()) {
      return NextResponse.json({ error: 'Tax ID is required' }, { status: 400 });
    }

    // Require the actual taxpayer email + full mailing address (uploaded-8821
    // feature). These populate the entity + Form 8821 Line 1 and aren't reliably
    // parseable from scanned forms, so we collect them explicitly.
    if (!signerFirstName || !signerLastName) {
      return NextResponse.json({ error: 'Signee first and last name are required' }, { status: 400 });
    }
    if (!signerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(signerEmail)) {
      return NextResponse.json({ error: 'A valid taxpayer email is required' }, { status: 400 });
    }
    if (!tpAddress || !tpCity || !tpState || !tpZip) {
      return NextResponse.json({ error: 'Taxpayer street address, city, state, and ZIP are required' }, { status: 400 });
    }

    // Mercury enrollment is now enforced inside checkOrderGate (called
    // earlier at line 39). The dedicated payment-paywall import was
    // removed in favor of unifying both checks into order-gate per the
    // 2026-05-14 policy update.

    const admin = createAdminClient();

    // Create batch
    const { data: batch, error: batchError } = (await supabase
      .from('batches')
      .insert({
        client_id: profile.client_id,
        uploaded_by: user.id,
        intake_method: 'pdf',
        entity_count: Math.max(files.length + uploadedPaths.length, 1),
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
        // Only claim "signed" when a signed PDF actually arrived. Without one
        // the order still lands, but as 'submitted' — it needs signature first.
        status: hasSignedPdf ? '8821_signed' : 'submitted',
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
      : ['2026'];

    let entityCount = 0;

    // One pass per PDF — whether it came through as multipart (`File`), was
    // already put in storage by the browser (`string` path), or is absent
    // entirely (`null` = order captured, 8821 still to be signed).
    const sources: (File | string | null)[] = hasSignedPdf
      ? [...uploadedPaths, ...files]
      : [null];

    for (const source of sources) {
      let filePath: string | null = null;
      let buffer: Buffer | null = null;

      if (typeof source === 'string') {
        // Browser already uploaded it. Trust the path (validated against this
        // client's prefix above) and pull the bytes back only so the taxpayer/
        // signer extraction below can run — that download is server-to-server
        // and not subject to the request-body cap.
        filePath = source;
        try {
          const { data: blob, error: dlErr } = await admin.storage.from('uploads').download(source);
          if (dlErr || !blob) {
            console.error('[upload/pdf] could not read pre-uploaded file:', dlErr?.message);
          } else {
            buffer = Buffer.from(await blob.arrayBuffer());
          }
        } catch (e) {
          console.warn('[upload/pdf] pre-uploaded download failed (non-fatal):', e);
        }
      } else if (source) {
        buffer = Buffer.from(await source.arrayBuffer());
        const candidatePath = `${profile.client_id}/8821/${Date.now()}-${source.name}`;

        // Upload to storage
        const { error: uploadError } = await admin.storage
          .from('uploads')
          .upload(candidatePath, buffer, {
            contentType: 'application/pdf',
            upsert: false,
          });

        if (uploadError) {
          // Previously this `continue`d, which silently discarded the entity
          // and left an order the processor thought succeeded with nothing in
          // it. Keep the entity — an order missing its PDF is recoverable by
          // re-upload; an order that never existed is not.
          console.error('PDF upload error (entity kept, 8821 pending):', uploadError);
        } else {
          filePath = candidatePath;
        }
      }

      // The PDF intake form doesn't capture the taxpayer address or the signer
      // name/title — but the uploaded 8821 already has them (Section 1 + 6).
      // Extract them so the entity is complete and the regenerated 8821 isn't
      // missing Line 1 / the signature block. Only trust the parse when the
      // extracted TIN matches this entity's TID.
      let extr: Awaited<ReturnType<typeof extractTaxpayerInfoFrom8821>> | null = null;
      if (buffer) {
        try {
          const info = await extractTaxpayerInfoFrom8821(buffer);
          if (info.tin && normalizeTin(info.tin) === normalizeTin(tid)) extr = info;
        } catch (e) {
          console.warn('[upload/pdf] taxpayer/signer extract failed (non-fatal):', e);
        }
      }

      // Create entity
      const entityInsert: Record<string, any> = {
        request_id: req.id,
        entity_name: entityName.trim(),
        tid: tid.trim(),
        tid_kind: ['SSN', 'ITIN'].includes(tidKind.toUpperCase()) ? 'SSN' : 'EIN',
        form_type: formType,
        years: parsedYears,
        fiscal_year_end_month: fiscalYearEndMonth,
        signed_8821_url: filePath,
        status: filePath ? '8821_signed' : 'submitted',
        // Manually-entered taxpayer contact + address are authoritative; the
        // 8821 parse is only a fallback for the signer name fields.
        signer_email: signerEmail,
        address: tpAddress || extr?.address || null,
        city: tpCity || extr?.city || null,
        state: tpState || extr?.state || null,
        zip_code: tpZip || extr?.zip || null,
        // Form-entered signee names are authoritative; 8821 parse is a fallback.
        signer_first_name: signerFirstName || extr?.signerFirstName || null,
        signer_last_name: signerLastName || extr?.signerLastName || null,
      };

      const grossReceipts: Record<string, unknown> = {};
      if (extr?.signerTitle) grossReceipts.signer_title = extr.signerTitle;
      if (entityTranscriptRequested) {
        grossReceipts.entity_transcript_order = {
          requested: true,
          price: 19.99,
          ordered_at: new Date().toISOString(),
        };
      }
      // Filing-Compliance Report order (MOD-228 Phase 2): account transcript
      // only, no income transcripts, billed at the filing-compliance SKU.
      if (formData.get('filing_compliance') === 'true') {
        grossReceipts.product_type = 'filing_compliance';
        grossReceipts.filing_compliance = {
          requested: true,
          price: 29.99,
          sku: 'filing-compliance-report',
          ordered_at: new Date().toISOString(),
        };
      }
      if (Object.keys(grossReceipts).length > 0) {
        entityInsert.gross_receipts = grossReceipts;
      }

      const { error: entError } = await supabase.from('request_entities').insert(entityInsert as any);

      if (entError) {
        console.error('Entity creation error:', entError);
      } else {
        entityCount++;
      }
    }

    // When the order arrived without a signed 8821, generate a pre-filled one
    // per entity and email it to the ordering processor so they can collect the
    // signature themselves. autoGenerate8821sForRequest skips any entity that
    // already has signed_8821_url, so this is a no-op on the normal path where
    // every PDF uploaded cleanly. Non-fatal: the order is already saved, and a
    // missing 8821 is recoverable from the request page.
    let generated8821 = 0;
    try {
      const genAdmin = createAdminClient();
      const res = await autoGenerate8821sForRequest(genAdmin, req.id, {
        email: user.email!,
        name: profile.full_name,
      });
      generated8821 = res.generated.length;
      if (generated8821 > 0) {
        console.log(`[pdf-upload] generated ${generated8821} pre-filled 8821(s), emailed=${res.emailed}`);
        // The processor now has a form to chase a signature with.
        await genAdmin.from('requests').update({ status: '8821_sent' }).eq('id', req.id);
        await genAdmin.from('request_entities')
          .update({ status: '8821_sent' })
          .eq('request_id', req.id)
          .is('signed_8821_url', null);
      }
    } catch (genErr) {
      console.error('[pdf-upload] 8821 auto-generate failed (order kept):', genErr);
    }

    // Auto-post the intake instruction note on each created entity so
    // the expert sees what was requested directly — no admin relay.
    // Driver: 2026-05-27 Matt "no admin back-and-forth" directive. PDF
    // intake usually creates a single entity per upload, but the helper
    // is per-entity so iterating handles the multi-PDF case too.
    try {
      const noteAdmin = createAdminClient();
      const { data: createdForNotes } = await noteAdmin
        .from('request_entities')
        .select('id, entity_name, form_type, years')
        .eq('request_id', req.id) as { data: any[] | null };
      // Debit prepaid credits for this order (no-op for non-credit / legacy
      // clients or pre-migration). Excludes W&I (W2_INCOME) entities.
      if (createdForNotes && createdForNotes.length > 0) {
        try {
          const { debitCreditsForEntities } = await import('@/lib/credits');
          const billableIds = createdForNotes.filter((e: any) => e.form_type !== 'W2_INCOME').map((e: any) => e.id);
          const { charged } = await debitCreditsForEntities(noteAdmin, profile.client_id!, billableIds);
          if (charged) console.log(`[pdf-upload] Debited ${charged} request(s) from credit wallet`);
        } catch (e) { console.warn('[pdf-upload] credit debit failed:', e); }
      }
      if (createdForNotes && createdForNotes.length > 0) {
        const requesterName = profile.full_name || user.email || 'Processor';
        const requesterRole = (['admin', 'expert', 'processor', 'manager'] as const)
          .includes((profile.role as any)) ? (profile.role as any) : 'processor';
        await Promise.allSettled(createdForNotes.map((e: any) =>
          autoPostIntakeNote(noteAdmin, {
            entityId: e.id,
            entityName: e.entity_name,
            formType: e.form_type,
            years: e.years,
            requesterUserId: user.id,
            requesterName,
            requesterRole,
            clientId: profile.client_id!,
            freeTextNotes: notes,
          }),
        ));
      }
    } catch (noteErr) {
      console.warn('[pdf-upload] intake-note autopost failed (non-fatal):', noteErr);
    }

    // Notify all admins about the new request in real-time
    try {
      const adminClient = createAdminClient();
      const { data: admins } = await adminClient
        .from('profiles')
        .select('email')
        .eq('role', 'admin');

      if (admins && admins.length > 0) {
        for (const admin of admins) {
          await sendAdminNewRequestNotification(
            admin.email,
            profile.full_name || user.email || 'Team Member',
            profile.role || 'processor',
            clientName,
            loanNumber!.trim(),
            entityCount,
            req.id
          );
        }
      }
    } catch (notifyErr) {
      console.error('[pdf-upload] Failed to send admin notification:', notifyErr);
    }

    // Notify manager(s) if processor ordered entity transcript
    if (entityTranscriptRequested) {
      try {
        const notifyAdmin = createAdminClient();
        const { data: managers } = await notifyAdmin
          .from('profiles')
          .select('email')
          .eq('client_id', profile.client_id)
          .eq('role', 'manager');

        if (managers && managers.length > 0) {
          const totalCost = entityCount * RATE_ENTITY_TRANSCRIPT;
          for (const mgr of managers) {
            await sendManagerEntityTranscriptNotification(
              mgr.email,
              profile.full_name || user.email || 'Team Member',
              clientName,
              loanNumber!.trim(),
              entityCount,
              totalCost,
              req.id
            );
          }
          console.log(`[pdf-upload] Notified ${managers.length} manager(s) about entity transcript add-on`);
        }
      } catch (managerNotifyErr) {
        console.error('[pdf-upload] Failed to send manager entity transcript notification:', managerNotifyErr);
      }
    }

    // Audit log: PDF upload completed.
    // Must use the service-role client: audit_log has no INSERT policy for
    // `authenticated`, so passing the user-scoped client made every write fail
    // with "new row violates row-level security policy" — swallowed by
    // logAuditEvent, so uploads looked fine while the trail silently went
    // missing. Matches the admin-client convention used by the other callers.
    await logAuditFromRequest(admin, request, {
      action: 'file_uploaded',
      resourceType: 'batch',
      resourceId: batch.id,
      details: {
        intake_method: 'pdf',
        file_count: files.length + uploadedPaths.length,
        direct_to_storage: uploadedPaths.length,
        entity_count: entityCount,
        prefilled_8821_count: generated8821,
        request_id: req.id,
        loan_number: loanNumber!.trim(),
      },
    });

    return NextResponse.json({
      success: true,
      batch_id: batch.id,
      request_id: req.id,
      entities_created: entityCount,
      // Tells the UI which of the two outcomes to render.
      signed_8821_received: hasSignedPdf,
      prefilled_8821_generated: generated8821,
    });
  } catch (err) {
    console.error('PDF upload error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Upload failed' },
      { status: 500 }
    );
  }
}

/**
 * Normalize a fiscal-year-end form-data value into a 1-11 month integer.
 * Returns null for empty / "12" / "Dec" / "12/31" / "December" (calendar
 * year is the default and stored as NULL in the DB).
 *
 * Mirrors the CSV intake's parseFyeMonth() — same accepted formats so a
 * lender can paste whatever shape they have ("2", "Feb", "2/28", "February").
 */
function parseFyeMonthFromFormData(raw: string | null): number | null {
  if (!raw) return null;
  const cleaned = String(raw).trim().toLowerCase();
  if (!cleaned) return null;
  if (/^(12|december|dec|12\/31|12-31)$/.test(cleaned)) return null;
  const intMatch = cleaned.match(/^(\d{1,2})$/);
  if (intMatch) {
    const m = parseInt(intMatch[1], 10);
    return m >= 1 && m <= 11 ? m : null;
  }
  const dateMatch = cleaned.match(/^(\d{1,2})[/-]\d{1,2}$/);
  if (dateMatch) {
    const m = parseInt(dateMatch[1], 10);
    return m >= 1 && m <= 11 ? m : null;
  }
  const months: Record<string, number> = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
    apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
    aug: 8, august: 8, sep: 9, sept: 9, september: 9,
    oct: 10, october: 10, nov: 11, november: 11,
  };
  return months[cleaned] ?? null;
}
