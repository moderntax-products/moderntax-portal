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
    };

    try {
      metadata = JSON.parse(metadataStr);
    } catch {
      return corsJson({ error: 'Invalid metadata JSON' }, { status: 400 });
    }

    // Clean TIN for matching (remove dashes, spaces)
    const cleanTin = (metadata.tin || '').replace(/[\s-]/g, '');
    const tinLast4 = cleanTin.slice(-4);

    if (!tinLast4 || tinLast4.length < 4) {
      return corsJson({
        error: 'Cannot match transcript — TIN not found in metadata',
        filename: metadata.filename,
      }, { status: 400 });
    }

    // Find matching entity assignment for this expert
    // Match by: TIN last 4 digits + form type + expert assignment
    const { data: assignments } = await supabase
      .from('expert_assignments')
      .select(`
        id, entity_id, status,
        request_entities(id, entity_name, tid, tid_kind, form_type, years, transcript_urls, status, request_id,
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
    const namePrefix = (metadata.taxpayerName || '').replace(/[^a-zA-Z]/g, '').substring(0, 3).toUpperCase();

    let match = assignments.find((a: any) => {
      const entity = a.request_entities;
      if (!entity) return false;
      const entityTin = (entity.tid || '').replace(/[\s-]/g, '');
      const entityTinLast4 = entityTin.slice(-4);
      const entityForm = normalizeForm(entity.form_type || '');

      return entityTinLast4 === tinLast4 && entityForm === targetForm;
    });

    // Fallback: match by TIN last 4 only (ignore form type)
    if (!match) {
      match = assignments.find((a: any) => {
        const entity = a.request_entities;
        if (!entity) return false;
        const entityTin = (entity.tid || '').replace(/[\s-]/g, '');
        const entityTinLast4 = entityTin.slice(-4);
        return entityTinLast4 === tinLast4;
      });
    }

    // Fallback: match by first 3 letters of name (when TIN is fully masked)
    if (!match && namePrefix.length >= 3) {
      match = assignments.find((a: any) => {
        const entity = a.request_entities;
        if (!entity) return false;
        const entityNamePrefix = (entity.entity_name || '').replace(/[^a-zA-Z]/g, '').substring(0, 3).toUpperCase();
        return entityNamePrefix === namePrefix;
      });
    }

    if (!match) {
      return corsJson({
        error: `No matching entity found for TIN ***${tinLast4} / ${metadata.formType}`,
        filename: metadata.filename,
        searched: assignments.length,
      }, { status: 404 });
    }

    const entity = match.request_entities;
    const entityId = entity.id;
    const assignmentId = match.id;

    // Upload file to Supabase storage
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

    // Append to entity's transcript_urls
    const existingUrls: string[] = entity.transcript_urls || [];
    const updatedUrls = [...existingUrls, storagePath];

    await supabase
      .from('request_entities')
      .update({ transcript_urls: updatedUrls })
      .eq('id', entityId);

    // Update assignment status to in_progress if still assigned
    if (match.status === 'assigned') {
      await supabase
        .from('expert_assignments')
        .update({ status: 'in_progress' })
        .eq('id', assignmentId);
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

      // Trigger upsell email for CRITICAL or WARNING findings
      if (['CRITICAL', 'WARNING'].includes(metadata.compliance.severity)) {
        try {
          // Get signer email from entity
          const { data: fullEntity } = await supabase
            .from('request_entities')
            .select('signer_email, entity_name, signer_first_name')
            .eq('id', entityId)
            .single() as { data: any; error: any };

          if (fullEntity?.signer_email) {
            const sgMail = require('@sendgrid/mail');
            sgMail.setApiKey(process.env.SENDGRID_API_KEY);

            const criticalFlags = metadata.compliance.flags
              .filter((f: any) => f.severity === 'CRITICAL')
              .map((f: any) => `<li style="color: #dc2626; margin: 4px 0;">${f.message}</li>`)
              .join('');

            const warningFlags = metadata.compliance.flags
              .filter((f: any) => f.severity === 'WARNING')
              .map((f: any) => `<li style="color: #d97706; margin: 4px 0;">${f.message}</li>`)
              .join('');

            const signerName = fullEntity.signer_first_name || fullEntity.entity_name || 'there';
            const bookingUrl = 'https://meetings.hubspot.com/matt-moderntax/moderntax-intro';

            await sgMail.send({
              to: fullEntity.signer_email,
              from: { email: process.env.SENDGRID_FROM_EMAIL || 'active-accounts@moderntax.io', name: 'ModernTax' },
              subject: `Tax Compliance Alert: ${fullEntity.entity_name} — Action May Be Required`,
              html: `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
  <div style="background: #1a1a2e; color: white; padding: 24px; text-align: center; border-radius: 8px 8px 0 0;">
    <h1 style="margin: 0; font-size: 22px;">Tax Compliance Review</h1>
    <p style="margin: 8px 0 0; opacity: 0.8;">ModernTax</p>
  </div>
  <div style="padding: 32px 24px; background: #ffffff; border: 1px solid #e5e7eb;">
    <p>Hi ${signerName},</p>
    <p>During our routine IRS transcript verification for <strong>${fullEntity.entity_name}</strong>, we identified the following items that may require attention:</p>
    ${criticalFlags ? `<div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 16px; margin: 16px 0;"><h3 style="color: #dc2626; margin: 0 0 8px; font-size: 14px;">Critical Items</h3><ul style="margin: 0; padding-left: 20px;">${criticalFlags}</ul></div>` : ''}
    ${warningFlags ? `<div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 16px; margin: 16px 0;"><h3 style="color: #d97706; margin: 0 0 8px; font-size: 14px;">Warnings</h3><ul style="margin: 0; padding-left: 20px;">${warningFlags}</ul></div>` : ''}
    <p>Our tax resolution team can help you address these items and get back into compliance. Schedule a free consultation:</p>
    <div style="text-align: center; margin: 24px 0;">
      <a href="${bookingUrl}" style="background: #16a34a; color: white; padding: 14px 36px; border-radius: 8px; text-decoration: none; font-weight: bold; display: inline-block; font-size: 16px;">Book a Free Consultation</a>
    </div>
    <p style="color: #6b7280; font-size: 13px;">This is an automated review based on IRS transcript data. For questions, reply to this email.</p>
  </div>
  <div style="padding: 16px 24px; background: #f9fafb; border-radius: 0 0 8px 8px; border: 1px solid #e5e7eb; border-top: none; text-align: center;">
    <p style="color: #9ca3af; font-size: 12px; margin: 0;">ModernTax — Tax Compliance & Resolution Services</p>
  </div>
</div>`.trim(),
              replyTo: 'support@moderntax.io',
            });

            console.log(`[batch-upload] Upsell email sent to ${fullEntity.signer_email} for ${fullEntity.entity_name} (${metadata.compliance.severity})`);
          }
        } catch (upsellErr) {
          console.error('[batch-upload] Upsell email failed:', upsellErr);
          // Don't fail the upload if upsell email fails
        }
      }
    }

    return corsJson({
      success: true,
      entityId,
      entityName: entity.entity_name,
      assignmentId,
      storagePath,
      totalFiles: updatedUrls.length,
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
        request_entities(id, entity_name, tid, tid_kind, form_type, years, transcript_urls)
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
      })),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return corsJson({ error: 'Internal server error', details: msg }, { status: 500 });
  }
}
