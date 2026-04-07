/**
 * Expert Batch Upload API
 * POST /api/expert/batch-upload
 *
 * Receives transcript PDFs directly from the IRS bookmarklet (v6+).
 * Auto-matches to the correct entity assignment by TIN + form type.
 * Stores compliance screening data. Triggers upsell emails for critical/warning findings.
 * Tracks transcript count per expert.
 *
 * Accepts multipart form data:
 *   - file: PDF blob
 *   - metadata: JSON string with { tin, formType, taxYear, shortType, taxpayerName, filename, compliance }
 *   - expertId: expert's user ID (from auth token in bookmarklet)
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { triggerIncrementalWebhook } from '@/lib/webhook';
import { triggerV3Webhook, type TranscriptUploadContext } from '@/lib/webhook-v3';

// Allow larger file uploads (IRS Record of Account transcripts can exceed 4MB)
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': 'https://la.www4.irs.gov',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

// Helper to add CORS headers to all responses
function corsJson(data: any, init?: { status?: number }) {
  const resp = NextResponse.json(data, init);
  Object.entries(CORS_HEADERS).forEach(([k, v]) => resp.headers.set(k, v));
  return resp;
}

// Handle CORS preflight
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(request: NextRequest) {
  try {
    // Auth via Bearer token (expert's session token from bookmarklet)
    const authHeader = request.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return corsJson({ error: 'Unauthorized' }, { status: 401 });
    }
    const token = authHeader.slice(7);

    const supabase = createAdminClient();

    // Verify expert identity from token
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return corsJson({ error: 'Invalid token' }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('id, role, full_name, email')
      .eq('id', user.id)
      .single() as { data: { id: string; role: string; full_name: string | null; email: string } | null; error: any };

    if (!profile || profile.role !== 'expert') {
      return corsJson({ error: 'Only experts can upload via this endpoint' }, { status: 403 });
    }

    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const htmlFile = formData.get('htmlFile') as File | null; // Optional HTML for webhook delivery
    const metadataStr = formData.get('metadata') as string | null;

    if (!file) return corsJson({ error: 'No file provided' }, { status: 400 });
    if (!metadataStr) return corsJson({ error: 'No metadata provided' }, { status: 400 });

    let metadata: {
      tin: string;
      formType: string;
      taxYear: string;
      shortType: string;
      taxpayerName: string;
      filename: string;
      compliance: any;
      transcriptCategory?: 'income' | 'payroll' | 'entity';
      entityData?: Record<string, string>;
    };

    try {
      metadata = JSON.parse(metadataStr);
    } catch {
      return corsJson({ error: 'Invalid metadata JSON' }, { status: 400 });
    }

    // Clean TIN for matching (remove dashes, spaces, asterisks from IRS masking)
    const cleanTin = (metadata.tin || '').replace(/[\s\-*]/g, '');
    const tinLast4 = cleanTin.length >= 4 ? cleanTin.slice(-4) : '';

    // Find matching entity assignment for this expert
    // Match by: TIN last 4 digits + form type + expert assignment (falls back to name match)
    const { data: assignments } = await supabase
      .from('expert_assignments')
      .select(`
        id, entity_id, status,
        request_entities(id, entity_name, tid, tid_kind, form_type, years, transcript_urls, transcript_html_urls, status, request_id,
          requests(client_id, requested_by, loan_number))
      `)
      .eq('expert_id', profile.id)
      .in('status', ['assigned', 'in_progress', 'completed']) as { data: any[] | null; error: any };

    if (!assignments || assignments.length === 0) {
      return corsJson({
        error: 'No assignments found for this expert',
        filename: metadata.filename,
      }, { status: 404 });
    }

    // Match by TIN last 4 + form type (IRS masks TINs, only last 4 visible)
    const normalizeForm = (f: string) => f.replace(/[\s-]/g, '').toUpperCase();
    const targetForm = normalizeForm(metadata.formType || '');
    const cleanName = (s: string) => s.replace(/[^a-zA-Z]/g, '').toUpperCase();
    const transcriptName = cleanName(metadata.taxpayerName || '');

    // Supplemental transcripts (941, 940, BMF_ENTITY) match by TIN only — they're
    // additional records attached to the entity, not the primary income form
    const isSupplemental = ['941', '940', 'BMF_ENTITY'].includes(targetForm) ||
      metadata.transcriptCategory === 'payroll' ||
      metadata.transcriptCategory === 'entity';

    // Helper: compute name similarity score (0-1) between transcript name and entity name
    const nameSimilarity = (entityName: string): number => {
      const entityClean = cleanName(entityName);
      if (!transcriptName || !entityClean) return 0;
      // Check if one contains the other
      if (entityClean.includes(transcriptName) || transcriptName.includes(entityClean)) return 1.0;
      // Check prefix match (first N chars)
      const minLen = Math.min(transcriptName.length, entityClean.length);
      let prefixMatch = 0;
      for (let i = 0; i < minLen; i++) {
        if (transcriptName[i] === entityClean[i]) prefixMatch++;
        else break;
      }
      if (prefixMatch >= 5) return 0.8; // 5+ char prefix match is strong
      if (prefixMatch >= 3) return 0.5; // 3-4 char prefix is moderate
      // Check word overlap
      const tWords = transcriptName.match(/.{3,}/g) || [];
      const overlap = tWords.filter(w => entityClean.includes(w)).length;
      if (overlap > 0) return 0.3 + (overlap / Math.max(tWords.length, 1)) * 0.4;
      return 0;
    };

    let match: any = null;
    let matchStrategy = '';

    // Strategy 1: TIN last 4 + form type (strongest match — skip for supplemental)
    if (tinLast4 && !isSupplemental) {
      match = assignments.find((a: any) => {
        const entity = a.request_entities;
        if (!entity) return false;
        const entityTin = (entity.tid || '').replace(/[\s\-*]/g, '');
        const entityTinLast4 = entityTin.slice(-4);
        const entityForm = normalizeForm(entity.form_type || '');
        return entityTinLast4 === tinLast4 && entityForm === targetForm;
      });
      if (match) matchStrategy = 'tin+form';
    }

    // Strategy 2: TIN last 4 + name confirmation (supplemental + fallback)
    // Prefer TIN match that also has name similarity, to avoid cross-entity mismatches
    if (!match && tinLast4) {
      const tinMatches = assignments.filter((a: any) => {
        const entity = a.request_entities;
        if (!entity) return false;
        const entityTin = (entity.tid || '').replace(/[\s\-*]/g, '');
        return entityTin.slice(-4) === tinLast4;
      });

      if (tinMatches.length === 1) {
        // Only one TIN match — safe to use
        match = tinMatches[0];
        matchStrategy = 'tin-only (unique)';
      } else if (tinMatches.length > 1 && transcriptName) {
        // Multiple TIN matches — pick the one with best name similarity
        let bestScore = 0;
        for (const candidate of tinMatches) {
          const score = nameSimilarity(candidate.request_entities?.entity_name || '');
          if (score > bestScore) {
            bestScore = score;
            match = candidate;
          }
        }
        if (match) matchStrategy = `tin+name (score=${bestScore.toFixed(2)}, ${tinMatches.length} candidates)`;
      } else if (tinMatches.length > 1) {
        // Multiple TIN matches, no name to disambiguate — use first (avoid wrong match)
        match = tinMatches[0];
        matchStrategy = `tin-only (first of ${tinMatches.length})`;
      }
    }

    // Strategy 3: Name similarity match (no TIN available — use 5+ char prefix)
    if (!match && transcriptName.length >= 5) {
      let bestScore = 0;
      let bestCandidate: any = null;
      for (const a of assignments) {
        const entity = a.request_entities;
        if (!entity) continue;
        const score = nameSimilarity(entity.entity_name || '');
        if (score > bestScore) {
          bestScore = score;
          bestCandidate = a;
        }
      }
      // Require at least moderate similarity (0.5 = 3+ char prefix)
      if (bestCandidate && bestScore >= 0.5) {
        match = bestCandidate;
        matchStrategy = `name-similarity (score=${bestScore.toFixed(2)})`;
      }
    }

    if (!match) {
      console.log(`[batch-upload] No match: TIN=***${tinLast4}, name="${metadata.taxpayerName}", form=${targetForm}, searched=${assignments.length}`);
      return corsJson({
        error: tinLast4
          ? `No matching entity found for TIN ***${tinLast4} / ${metadata.formType}`
          : `Cannot match transcript — TIN not found in metadata`,
        filename: metadata.filename,
        searched: assignments.length,
      }, { status: 404 });
    }

    console.log(`[batch-upload] Matched "${metadata.taxpayerName}" → ${match.request_entities?.entity_name} via ${matchStrategy}`);

    const entity = match.request_entities;
    const entityId = entity.id;
    const assignmentId = match.id;

    // Dedup check: build a key from formType + shortType + taxYear to detect re-uploads
    const transcriptKey = `${(metadata.formType || '').trim()} ${(metadata.shortType || '').trim()} - ${(metadata.taxYear || '').trim()}`.toLowerCase();
    const existingUrls: string[] = entity.transcript_urls || [];
    const alreadyUploaded = existingUrls.some((url: string) => {
      // Extract filename from storage path (after the timestamp prefix)
      const filename = url.split('/').pop() || '';
      // Remove timestamp prefix (digits followed by dash)
      const cleanFilename = filename.replace(/^\d+-/, '').toLowerCase();
      return cleanFilename.includes(transcriptKey.replace(/\s+/g, ' '));
    });

    if (alreadyUploaded) {
      return corsJson({
        success: true,
        duplicate: true,
        entityId,
        entityName: entity.entity_name,
        assignmentId,
        totalFiles: existingUrls.length,
        filename: metadata.filename,
        message: 'Transcript already uploaded — skipped duplicate',
      });
    }

    // Look up client transcript format preference
    const clientId = entity.requests?.client_id;
    let transcriptFormat: 'html' | 'pdf' = 'pdf'; // default
    if (clientId) {
      const { data: client } = await supabase
        .from('clients')
        .select('domain')
        .eq('id', clientId)
        .single() as { data: { domain: string } | null; error: any };

      if (client?.domain) {
        const { CLIENT_CONFIG } = await import('@/lib/clients');
        transcriptFormat = CLIENT_CONFIG[client.domain]?.transcript_format || 'pdf';
      }
    }

    // Upload PDF file to Supabase storage
    const buffer = Buffer.from(await file.arrayBuffer());
    const sanitizedFilename = metadata.filename
      .replace(/[^a-zA-Z0-9._\-\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const storagePath = `transcripts/${entityId}/${Date.now()}-${sanitizedFilename}`;

    const { error: uploadError } = await supabase.storage
      .from('uploads')
      .upload(storagePath, buffer, {
        contentType: file.type || 'application/pdf',
        upsert: false,
      });

    if (uploadError) {
      return corsJson({
        error: 'Failed to upload file to storage',
        details: uploadError.message,
        filename: metadata.filename,
      }, { status: 500 });
    }

    // Upload HTML file if provided
    let htmlStoragePath: string | null = null;
    if (htmlFile) {
      try {
        const htmlBuffer = Buffer.from(await htmlFile.arrayBuffer());
        htmlStoragePath = `transcripts/${entityId}/${Date.now()}-${sanitizedFilename.replace(/\.pdf$/i, '')}.html`;

        const { error: htmlUploadError } = await supabase.storage
          .from('uploads')
          .upload(htmlStoragePath, htmlBuffer, {
            contentType: 'text/html',
            upsert: false,
          });

        if (htmlUploadError) {
          console.error('[batch-upload] HTML upload error:', htmlUploadError);
          htmlStoragePath = null;
        }
      } catch (htmlErr) {
        console.error('[batch-upload] HTML processing error:', htmlErr);
        htmlStoragePath = null;
      }
    }

    // Determine primary/secondary storage based on client transcript format preference
    // transcript_urls = primary format (what processors download)
    // transcript_html_urls = secondary format (fallback)
    const existingHtmlUrls: string[] = (entity as any).transcript_html_urls || [];

    const entityUpdate: Record<string, unknown> = {};

    if (transcriptFormat === 'html' && htmlStoragePath) {
      // HTML-preferring client: HTML is primary, PDF is secondary
      entityUpdate.transcript_urls = [...existingUrls, htmlStoragePath];
      entityUpdate.transcript_html_urls = [...existingHtmlUrls, storagePath];
    } else {
      // PDF-preferring client (default): PDF is primary, HTML is secondary
      entityUpdate.transcript_urls = [...existingUrls, storagePath];
      if (htmlStoragePath) {
        entityUpdate.transcript_html_urls = [...existingHtmlUrls, htmlStoragePath];
      }
    }

    await supabase
      .from('request_entities')
      .update(entityUpdate)
      .eq('id', entityId);

    // Trigger webhooks for API-intake clients (e.g., ClearFirm)
    const htmlPathForWebhook = transcriptFormat === 'html' && htmlStoragePath
      ? htmlStoragePath
      : htmlStoragePath || null;

    if (entity.request_id) {
      // Read raw HTML content for v3 structured webhook
      let rawHtmlContent: string | undefined;
      if (htmlPathForWebhook) {
        try {
          const { data: htmlBlob } = await supabase.storage
            .from('uploads')
            .download(htmlPathForWebhook);
          if (htmlBlob) rawHtmlContent = await htmlBlob.text();
        } catch (err) {
          console.error('[batch-upload] Failed to read HTML for v3 webhook:', err);
        }
      }

      // Build compliance data from metadata for v3 payload
      const v3ComplianceData = metadata.compliance ? {
        severity: metadata.compliance.severity,
        flags: metadata.compliance.flags,
        financials: {
          grossReceipts: metadata.compliance.grossReceipts ?? null,
          totalIncome: metadata.compliance.totalIncome ?? null,
          totalDeductions: metadata.compliance.totalDeductions ?? null,
          totalTax: metadata.compliance.totalTax ?? null,
          accountBalance: metadata.compliance.accountBalance ?? null,
          accruedInterest: metadata.compliance.accruedInterest ?? null,
          accruedPenalty: metadata.compliance.accruedPenalty ?? null,
        },
      } : null;

      // v3 structured webhook (primary — structured JSON + raw HTML)
      const v3Context: TranscriptUploadContext = {
        requestToken: '', // will be resolved from DB
        entity: {
          ...entity,
          id: entityId,
          request_id: entity.request_id,
          gross_receipts: (entity as any).gross_receipts || null,
        },
        formType: metadata.formType || entity.form_type || '',
        taxYear: metadata.taxYear || '',
        transcriptCategory: metadata.transcriptCategory,
        complianceData: v3ComplianceData,
        entityData: metadata.entityData || null,
        rawHtml: rawHtmlContent,
      };

      triggerV3Webhook(supabase, v3Context).catch((err: any) => {
        console.error('[batch-upload] V3 webhook failed:', err);
      });

      // v2 incremental webhook (backward-compat — raw HTML only)
      if (htmlPathForWebhook) {
        triggerIncrementalWebhook(
          supabase,
          entity.request_id,
          entityId,
          entity.entity_name,
          metadata.formType || entity.form_type || '',
          htmlPathForWebhook
        ).catch((err: any) => {
          console.error('[batch-upload] V2 incremental webhook failed:', err);
        });
      }
    }

    // Update assignment status to in_progress if still assigned
    if (match.status === 'assigned') {
      await supabase
        .from('expert_assignments')
        .update({ status: 'in_progress' })
        .eq('id', assignmentId);
    }

    // Store entity transcript data (filing requirements, NAICS, etc.) if provided
    if (metadata.entityData && metadata.transcriptCategory === 'entity') {
      const existingCompliance = (entity.gross_receipts as any) || {};
      const updatedData = {
        ...existingCompliance,
        entity_transcript: {
          ...metadata.entityData,
          retrieved_at: new Date().toISOString(),
        },
      };

      await supabase
        .from('request_entities')
        .update({ gross_receipts: updatedData })
        .eq('id', entityId);

      console.log(`[batch-upload] Stored entity transcript data for ${entity.entity_name}: filing=${metadata.entityData.filingRequirements || 'N/A'}`);
    }

    // Store compliance data if provided
    if (metadata.compliance && metadata.compliance.flags && metadata.compliance.flags.length > 0) {
      // Store in entity's gross_receipts JSONB (compliance screening data)
      const existingCompliance = (entity.gross_receipts as any) || {};
      const complianceKey = `${metadata.formType}_${metadata.shortType}_${metadata.taxYear}`.replace(/\s+/g, '_');

      const updatedCompliance = {
        ...existingCompliance,
        [complianceKey]: {
          severity: metadata.compliance.severity,
          flags: metadata.compliance.flags,
          financials: {
            grossReceipts: metadata.compliance.grossReceipts,
            totalIncome: metadata.compliance.totalIncome,
            totalDeductions: metadata.compliance.totalDeductions,
            totalTax: metadata.compliance.totalTax,
            accountBalance: metadata.compliance.accountBalance,
            accruedInterest: metadata.compliance.accruedInterest,
            accruedPenalty: metadata.compliance.accruedPenalty,
          },
          screened_at: new Date().toISOString(),
        },
      };

      await supabase
        .from('request_entities')
        .update({ gross_receipts: updatedCompliance })
        .eq('id', entityId);

      // Enroll in compliance drip sequence for CRITICAL or WARNING findings
      if (['CRITICAL', 'WARNING'].includes(metadata.compliance.severity)) {
        try {
          const { classifyFlags, sendDripEmail } = require('@/lib/compliance-drip');
          const { data: fullEntity } = await supabase
            .from('request_entities')
            .select('signer_email, entity_name, signer_first_name, gross_receipts')
            .eq('id', entityId)
            .single() as { data: any; error: any };

          if (fullEntity?.signer_email) {
            const classification = classifyFlags(fullEntity.gross_receipts || updatedCompliance);

            // Check if already enrolled
            const { data: existing } = await supabase
              .from('compliance_drip')
              .select('id')
              .eq('entity_id', entityId)
              .single() as { data: any; error: any };

            if (!existing) {
              // Create drip record and send first email immediately
              const { data: drip } = await (supabase
                .from('compliance_drip' as any)
                .insert({
                  entity_id: entityId,
                  flag_category: classification.category,
                  flag_severity: classification.severity,
                  balance_due: classification.balanceDue || null,
                  accrued_penalty: classification.penalty || null,
                  accrued_interest: classification.interest || null,
                  total_exposure: classification.totalExposure || null,
                  drip_stage: 0,
                  next_email_due_at: new Date().toISOString(),
                  signer_email: fullEntity.signer_email,
                  signer_name: fullEntity.signer_first_name || null,
                  entity_name: fullEntity.entity_name,
                })
                .select('*')
                .single()) as { data: any; error: any };

              if (drip) {
                // Send Stage 0 email immediately
                const sent = await sendDripEmail(0, drip, classification.allFlags);
                if (sent) {
                  const nextDue = new Date();
                  nextDue.setDate(nextDue.getDate() + 3); // Next email in 3 days
                  await (supabase
                    .from('compliance_drip' as any)
                    .update({
                      email_0_sent_at: new Date().toISOString(),
                      last_email_sent_at: new Date().toISOString(),
                      drip_stage: 1,
                      next_email_due_at: nextDue.toISOString(),
                    } as any)
                    .eq('id', drip.id));
                }
                console.log(`[batch-upload] Enrolled ${fullEntity.entity_name} in compliance drip (${classification.category}, ${classification.severity})`);
              }
            }
          }
        } catch (dripErr) {
          console.error('[batch-upload] Compliance drip enrollment failed:', dripErr);
          // Don't fail the upload if drip enrollment fails
        }
      }
    }

    return corsJson({
      success: true,
      entityId,
      entityName: entity.entity_name,
      assignmentId,
      storagePath,
      totalFiles: (entityUpdate.transcript_urls as string[]).length,
      filename: metadata.filename,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[batch-upload] Error:', msg);
    return corsJson({ error: 'Internal server error', details: msg }, { status: 500 });
  }
}

/**
 * GET /api/expert/batch-upload
 * Returns expert's auth token and assignment summary for the bookmarklet config
 */
export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return corsJson({ error: 'Unauthorized' }, { status: 401 });
    }
    const token = authHeader.slice(7);

    const supabase = createAdminClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return corsJson({ error: 'Invalid token' }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('id, role, full_name')
      .eq('id', user.id)
      .single() as { data: any; error: any };

    if (!profile || profile.role !== 'expert') {
      return corsJson({ error: 'Not an expert' }, { status: 403 });
    }

    // Get active assignments
    const { data: assignments } = await supabase
      .from('expert_assignments')
      .select(`
        id, status,
        request_entities(id, entity_name, tid, tid_kind, form_type, years, transcript_urls, gross_receipts)
      `)
      .eq('expert_id', profile.id)
      .in('status', ['assigned', 'in_progress'])
      .order('assigned_at', { ascending: false }) as { data: any[] | null; error: any };

    // Get total transcript count for this expert (all time)
    const { data: allAssignments } = await supabase
      .from('expert_assignments')
      .select('request_entities(transcript_urls)')
      .eq('expert_id', profile.id)
      .eq('status', 'completed') as { data: any[] | null; error: any };

    let totalTranscriptsUploaded = 0;
    (allAssignments || []).forEach((a: any) => {
      totalTranscriptsUploaded += (a.request_entities?.transcript_urls?.length || 0);
    });

    return corsJson({
      expert: {
        id: profile.id,
        name: profile.full_name,
        totalTranscriptsUploaded,
      },
      assignments: (assignments || []).map((a: any) => ({
        assignmentId: a.id,
        status: a.status,
        entityId: a.request_entities?.id,
        entityName: a.request_entities?.entity_name,
        tin: a.request_entities?.tid,
        tinKind: a.request_entities?.tid_kind,
        formType: a.request_entities?.form_type,
        years: a.request_entities?.years,
        uploadedFiles: a.request_entities?.transcript_urls?.length || 0,
        entityTranscriptRequested: !!(a.request_entities?.gross_receipts as any)?.entity_transcript_order?.requested,
        filingRequirements: (a.request_entities?.gross_receipts as any)?.entity_transcript?.filingRequirements || null,
      })),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return corsJson({ error: 'Internal server error', details: msg }, { status: 500 });
  }
}
