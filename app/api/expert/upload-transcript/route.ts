import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import { sendExpertCompletionNotification, sendCompletionNotification } from '@/lib/sendgrid';
import { triggerWebhookForRequest, triggerIncrementalWebhook } from '@/lib/webhook';
import { autoEnrollMonitoring } from '@/lib/repeat-entity';

/**
 * Expert transcript upload route.
 * Supports uploading one file at a time to avoid Vercel's 4.5MB body size limit.
 * Include `complete=true` in FormData on the final upload to complete the assignment.
 */
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
      .select('role, full_name')
      .eq('id', user.id)
      .single();

    if (!profile || profile.role !== 'expert') {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const formData = await request.formData();
    const assignmentId = formData.get('assignmentId') as string | null;
    const entityId = formData.get('entityId') as string | null;
    const shouldComplete = formData.get('complete') === 'true';

    if (!assignmentId || !entityId) {
      return NextResponse.json(
        { error: 'assignmentId and entityId are required' },
        { status: 400 }
      );
    }

    // Get uploaded files (may be 0 if just completing)
    const files: File[] = [];
    for (const [key, value] of formData.entries()) {
      if (key === 'files' && value instanceof File) {
        files.push(value);
      }
    }

    if (files.length === 0 && !shouldComplete) {
      return NextResponse.json({ error: 'No files uploaded' }, { status: 400 });
    }

    const adminSupabase = createAdminClient();

    // Verify the expert owns this assignment
    const { data: assignment } = await adminSupabase
      .from('expert_assignments')
      .select('id, expert_id, status, entity_id, sla_deadline')
      .eq('id', assignmentId)
      .single();

    if (!assignment) {
      return NextResponse.json({ error: 'Assignment not found' }, { status: 404 });
    }

    if (assignment.expert_id !== user.id) {
      return NextResponse.json({ error: 'Not your assignment' }, { status: 403 });
    }

    if (assignment.entity_id !== entityId) {
      return NextResponse.json({ error: 'Entity mismatch' }, { status: 400 });
    }

    if (!['assigned', 'in_progress', 'completed'].includes(assignment.status)) {
      return NextResponse.json(
        { error: 'Assignment is not active' },
        { status: 400 }
      );
    }

    // Get existing entity data. gross_receipts is read for the post-completion
    // add-on hooks: cash_flow_pack_pre_ordered → auto-generate the SBA pack;
    // skip_auto_monitoring → bypass monitoring auto-enroll for this entity.
    const { data: entity } = await adminSupabase
      .from('request_entities')
      .select('id, entity_name, transcript_urls, request_id, form_type, years, signed_8821_url, gross_receipts, tid, requests(loan_number, client_id, clients(slug, name))')
      .eq('id', entityId)
      .single() as { data: any; error: any };

    if (!entity) {
      return NextResponse.json({ error: 'Entity not found' }, { status: 404 });
    }

    // Hard guard: every transcript upload must trace back to a signed 8821
    // (or Clearfirm's API-intake path, which delegates auth to the client).
    // Previously this was unenforced — 163 production rows accumulated
    // transcripts without an 8821, creating an authorization paper trail gap.
    // Pre-portal HIST-* entities are exempt because their 8821s live in legacy
    // records outside the portal (migration backfill); we rely on loan_number
    // prefix to identify them.
    const loanNumber: string = entity.requests?.loan_number || '';
    const clientSlug: string = entity.requests?.clients?.slug || '';
    const isPrePortalBackfill = loanNumber.startsWith('HIST-');
    const isClearfirmApi = clientSlug === 'clearfirm' || /^CF-/i.test(loanNumber);
    if (!entity.signed_8821_url && !isPrePortalBackfill && !isClearfirmApi && files.length > 0) {
      return NextResponse.json(
        {
          error: 'Entity has no signed 8821 on file. Upload the signed 8821 before uploading transcripts.',
          entity_id: entityId,
          entity_name: entity.entity_name,
        },
        { status: 400 },
      );
    }

    // Scope check: warn (don't block) if uploaded filenames reference a year
    // outside the 8821-authorized `entity.years`. Stored as a flag on the
    // response so the expert sees a notice but the upload still completes —
    // hard-blocking would break the 25 already-overrun entities.
    const scopeWarnings: string[] = [];
    const authorizedYears = new Set<string>((entity.years || []).map((y: string) => String(y).trim()));
    if (authorizedYears.size > 0 && files.length > 0) {
      for (const f of files) {
        const yearsInName = Array.from(f.name.matchAll(/\b(20\d{2})\b/g)).map(m => m[1]);
        const unauthorized = yearsInName.filter(y => !authorizedYears.has(y));
        if (unauthorized.length > 0) {
          scopeWarnings.push(
            `${f.name}: references year(s) ${unauthorized.join(', ')} not on the 8821 (authorized: ${[...authorizedYears].sort().join(', ')}).`,
          );
        }
      }
    }

    // Upload transcript files (if any provided)
    const uploadedUrls: string[] = [];
    for (const file of files) {
      const buffer = Buffer.from(await file.arrayBuffer());
      const filePath = `transcripts/${entityId}/${Date.now()}-${file.name}`;

      const contentType = file.name.endsWith('.html') || file.name.endsWith('.htm')
        ? 'text/html'
        : 'application/pdf';

      const { error: uploadError } = await adminSupabase.storage
        .from('uploads')
        .upload(filePath, buffer, {
          contentType,
          upsert: false,
        });

      if (uploadError) {
        console.error('Transcript upload error:', uploadError);
        return NextResponse.json(
          { error: `Failed to upload ${file.name}: ${uploadError.message}` },
          { status: 500 }
        );
      }

      uploadedUrls.push(filePath);
    }

    // Append new file URLs to entity transcript_urls
    if (uploadedUrls.length > 0) {
      const existingUrls = entity.transcript_urls || [];
      const allUrls = [...existingUrls, ...uploadedUrls];

      await adminSupabase
        .from('request_entities')
        .update({ transcript_urls: allUrls })
        .eq('id', entityId);

      // Trigger incremental webhook for each HTML file uploaded
      for (const url of uploadedUrls) {
        if (url.endsWith('.html') || url.endsWith('.htm')) {
          triggerIncrementalWebhook(
            adminSupabase,
            entity.request_id,
            entityId,
            entity.entity_name,
            (entity as any).form_type || '',
            url
          ).catch((err: any) => {
            console.error('[upload-transcript] Incremental webhook failed:', err);
          });
        }
      }
    }

    // If this is the completion call, finalize the assignment
    let slaMet: boolean | null = null;
    let monitoringAutoEnrolled = false;
    if (shouldComplete) {
      // Update entity status to completed
      await adminSupabase
        .from('request_entities')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
        })
        .eq('id', entityId);

      // Income-monitoring capture (Enterprise Bank / Derek Le ask 2026-05-11):
      // baseline the entity's income on first pull, compare on each subsequent
      // pull. Best-effort — a failure here MUST NOT abort completion since the
      // transcripts are already on file and the entity is rightfully "done".
      // Material variance (>15% on any income field) triggers an email alert.
      try {
        const { captureEntityIncome } = await import('@/lib/income-monitoring-hook');
        const incomeResult = await captureEntityIncome(entityId, adminSupabase);
        if (incomeResult.baselineEstablished) {
          console.log(`[income-monitoring] baseline established for entity ${entityId}`);
        } else if (incomeResult.variance) {
          console.log(`[income-monitoring] variance ${incomeResult.variance.overallSeverity} for entity ${entityId}; alert sent=${incomeResult.alertSent}`);
        } else if (incomeResult.skipReason) {
          console.log(`[income-monitoring] skipped entity ${entityId}: ${incomeResult.skipReason}`);
        }
      } catch (incomeErr) {
        console.error('[income-monitoring] hook failed (non-blocking):', incomeErr);
      }

      // Auto-enroll completed entities in continuous monitoring (default-on at
      // funding). Lender opts out at the client level via
      // clients.monitoring_default_enabled = false. The whole point: every
      // funded loan converts to recurring quarterly transcript pulls
      // ($19.99 enrollment + $39.99 per pull) so we own loan-servicing for
      // the full SBA loan life (~25 years).
      //
      // Skipped for:
      //   • W2_INCOME entities (transient W&I docs, not borrower-level monitoring)
      //   • Clients that opted out (monitoring_default_enabled = false)
      //   • Repeat-entity flow already enrolled (autoEnrollMonitoring is idempotent)
      try {
        const clientId: string | null = entity.requests?.client_id || null;
        const isW2 = entity.form_type === 'W2_INCOME';

        // Three-way precedence on monitoring auto-enroll:
        //   1. Per-entity opt-out at CSV upload (gross_receipts.skip_auto_monitoring)
        //      — explicit processor decision, highest priority.
        //   2. Per-client default (clients.monitoring_default_enabled).
        //   3. Hard skip for W2_INCOME (always — they're transient W&I docs).
        const perEntityOptOut = entity.gross_receipts?.skip_auto_monitoring?.requested === true;

        let monitoringEnabled = true;
        if (clientId) {
          const { data: client } = (await adminSupabase
            .from('clients')
            .select('monitoring_default_enabled')
            .eq('id', clientId)
            .single()) as { data: { monitoring_default_enabled: boolean | null } | null; error: any };
          if (client?.monitoring_default_enabled === false) monitoringEnabled = false;
        }

        if (clientId && monitoringEnabled && !isW2 && !perEntityOptOut) {
          monitoringAutoEnrolled = await autoEnrollMonitoring(
            adminSupabase as any,
            entityId,
            entity.request_id,
            clientId,
            user.id,
          );
          if (monitoringAutoEnrolled) {
            console.log(`[upload-transcript] Auto-enrolled ${entityId} in monitoring (post-completion)`);
          }
        } else if (perEntityOptOut) {
          console.log(`[upload-transcript] Skipped monitoring for ${entityId} — processor opted out at CSV upload`);
        }
      } catch (enrollErr) {
        // Best-effort — completion shouldn't fail because monitoring enroll did.
        console.error('[upload-transcript] Auto-enroll monitoring failed:', enrollErr);
      }

      // Cash-Flow Pack auto-generation. Two trigger paths:
      //   1. Per-entity pre-order from CSV upload (gross_receipts.cash_flow_pack_pre_ordered)
      //   2. Per-client auto-attach toggle (clients.cash_flow_auto_attach = true)
      // The /api/cash-flow/generate endpoint handles idempotency for manual
      // re-runs; this hook short-circuits if a pack already exists on the entity.
      try {
        const preOrdered = entity.gross_receipts?.cash_flow_pack_pre_ordered?.requested === true;
        const alreadyGenerated = !!entity.gross_receipts?.cash_flow_pack;
        const clientId: string | null = entity.requests?.client_id || null;
        let autoAttach = false;
        if (!preOrdered && clientId) {
          const { data: client } = (await adminSupabase
            .from('clients')
            .select('cash_flow_auto_attach')
            .eq('id', clientId)
            .single()) as { data: { cash_flow_auto_attach: boolean | null } | null; error: any };
          if (client?.cash_flow_auto_attach === true) autoAttach = true;
        }

        if ((preOrdered || autoAttach) && !alreadyGenerated) {
          const { generateCashFlowPdf, aggregateCashFlowByYear } = await import('@/lib/cash-flow-pdf');
          // Re-fetch the entity row so we get the latest gross_receipts (the
          // expert may have just uploaded transcripts with screening data
          // that updated the financials JSON).
          const { data: freshEntity } = await adminSupabase
            .from('request_entities')
            .select('gross_receipts')
            .eq('id', entity.id)
            .single() as { data: { gross_receipts: any } | null };
          const gr = freshEntity?.gross_receipts || entity.gross_receipts;
          const yearRows = aggregateCashFlowByYear(gr || null);
          if (yearRows.length > 0) {
            const pdfBytes = await generateCashFlowPdf({
              entityName: entity.entity_name,
              tin: entity.tid || '',
              formType: entity.form_type || '',
              loanNumber: entity.requests?.loan_number || null,
              lenderName: entity.requests?.clients?.name || 'Lender',
              grossReceipts: gr || null,
              generatedAt: new Date(),
              generatedBy: profile.full_name || user.email || 'ModernTax',
            });
            const filePath = `cash-flow-packs/${entity.id}/${Date.now()}-cash-flow-pack.pdf`;
            const { error: upErr } = await adminSupabase.storage
              .from('uploads')
              .upload(filePath, Buffer.from(pdfBytes), {
                contentType: 'application/pdf',
                upsert: false,
              });
            if (!upErr) {
              const pack = {
                generated_at: new Date().toISOString(),
                generated_by: user.id,
                generated_by_name: profile.full_name || 'expert',
                pdf_url: filePath,
                price: 49.99,
                years_covered: yearRows.length,
                year_range: yearRows.map((r: any) => r.year).join(', '),
                billed: false,
                trigger: preOrdered ? 'csv_pre_order' : 'client_auto_attach',
              };
              await adminSupabase
                .from('request_entities')
                .update({
                  gross_receipts: { ...(gr || {}), cash_flow_pack: pack },
                })
                .eq('id', entity.id);
              console.log(`[upload-transcript] Generated cash-flow pack for ${entity.id} (trigger: ${pack.trigger})`);
            } else {
              console.error('[upload-transcript] Cash-flow PDF upload failed:', upErr);
            }
          } else {
            console.log(`[upload-transcript] Cash-flow pack skipped for ${entity.id} — no financials extracted yet`);
          }
        }
      } catch (cfErr) {
        // Best-effort — completion succeeds even if pack generation fails. The
        // pack can be generated manually later from the entity card.
        console.error('[upload-transcript] Cash-flow pack auto-gen failed:', cfErr);
      }

      // Update assignment as completed and compute SLA
      const completedAt = new Date();
      slaMet = completedAt <= new Date(assignment.sla_deadline);

      await adminSupabase
        .from('expert_assignments')
        .update({
          status: 'completed',
          completed_at: completedAt.toISOString(),
          sla_met: slaMet,
        })
        .eq('id', assignmentId);

      // Check if all entities in the request are completed
      const { data: requestEntities } = await adminSupabase
        .from('request_entities')
        .select('id, status')
        .eq('request_id', entity.request_id);

      const allCompleted = requestEntities?.every((e) => e.status === 'completed');

      if (allCompleted) {
        await adminSupabase
          .from('requests')
          .update({
            status: 'completed',
            completed_at: new Date().toISOString(),
          })
          .eq('id', entity.request_id);
      }

      // Audit log
      await logAuditFromRequest(adminSupabase, request, {
        action: 'expert_transcript_uploaded',
        userId: user.id,
        userEmail: user.email || '',
        resourceType: 'request_entity',
        resourceId: entityId,
        details: {
          assignment_id: assignmentId,
          file_count: uploadedUrls.length,
          sla_met: slaMet,
          transcript_urls: uploadedUrls,
          request_id: entity.request_id,
        },
      });

      // Notify admin users
      try {
        const { data: admins } = await adminSupabase
          .from('profiles')
          .select('email')
          .eq('role', 'admin');

        if (admins) {
          for (const admin of admins) {
            await sendExpertCompletionNotification(
              admin.email,
              profile.full_name || user.email || 'Expert',
              entity.entity_name,
              entity.request_id
            );
          }
        }
      } catch (emailError) {
        console.error('Failed to send completion notifications:', emailError);
      }

      // Notify the processor that transcripts are ready (if all entities completed)
      if (allCompleted) {
        try {
          const { data: requestData } = await adminSupabase
            .from('requests')
            .select('id, loan_number, requested_by, profiles!requests_requested_by_fkey(email)')
            .eq('id', entity.request_id)
            .single();

          const processorEmail = (requestData as any)?.profiles?.email;
          if (processorEmail) {
            const { data: completedEntities } = await adminSupabase
              .from('request_entities')
              .select('*')
              .eq('request_id', entity.request_id);

            if (completedEntities) {
              await sendCompletionNotification(
                processorEmail,
                requestData as any,
                completedEntities as any
              );
            }
          }
        } catch (procEmailError) {
          console.error('Failed to send processor completion notification:', procEmailError);
        }

        // Trigger webhook for API-intake requests (e.g., ClearFirm)
        try {
          await triggerWebhookForRequest(adminSupabase, entity.request_id);
        } catch (webhookError) {
          console.error('Failed to trigger webhook:', webhookError);
          // Webhook retry cron will handle it
        }
      }
    }

    return NextResponse.json({
      success: true,
      uploaded_count: uploadedUrls.length,
      transcript_urls: uploadedUrls,
      completed: shouldComplete,
      sla_met: slaMet,
      scope_warnings: scopeWarnings.length > 0 ? scopeWarnings : undefined,
    });
  } catch (error) {
    console.error('Transcript upload error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 }
    );
  }
}
