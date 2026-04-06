/**
 * Stuck Entity Alert Cron Job
 * Alerts admins about entities that are stuck in various pipeline stages
 * GET /api/cron/stuck-entity-alert
 *
 * Checks for:
 * - 8821_sent status > 5 days (unsigned)
 * - irs_queue status > 48 hours (waiting for expert)
 * - processing status > 48 hours (stalled)
 *
 * Scheduled: Daily at 8:00 AM UTC (vercel.json)
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import sgMail from '@sendgrid/mail';

interface StuckEntity {
  entity_name: string;
  loan_number: string;
  updated_at: string;
  stuckValue: string; // human-readable duration
  expert_name: string | null;
  client_name: string | null;
}

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  try {
    // Validate CRON_SECRET
    const cronSecret = request.headers.get('Authorization');
    const expectedSecret = process.env.CRON_SECRET;

    if (!cronSecret || !expectedSecret || cronSecret !== `Bearer ${expectedSecret}`) {
      return NextResponse.json(
        { error: 'Unauthorized: Invalid CRON_SECRET' },
        { status: 401 }
      );
    }

    const supabase = createAdminClient();

    const now = new Date();
    const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const fortyEightHoursAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();

    // Query unsigned 8821s (status = '8821_sent', updated_at < 5 days ago)
    const { data: unsigned8821s, error: err1 } = await supabase
      .from('request_entities')
      .select('id, entity_name, status, updated_at, request_id, requests(loan_number)')
      .eq('status', '8821_sent')
      .lt('updated_at', fiveDaysAgo) as { data: any[] | null; error: any };

    if (err1) console.error('Error querying unsigned 8821s:', err1.message);

    // Query waiting for expert (status = 'irs_queue', updated_at < 48 hours ago)
    const { data: waitingForExpert, error: err2 } = await supabase
      .from('request_entities')
      .select('id, entity_name, status, updated_at, request_id, requests(loan_number)')
      .eq('status', 'irs_queue')
      .lt('updated_at', fortyEightHoursAgo) as { data: any[] | null; error: any };

    if (err2) console.error('Error querying irs_queue entities:', err2.message);

    // Query processing stalled (status = 'processing', updated_at < 48 hours ago)
    const { data: processingStalled, error: err3 } = await supabase
      .from('request_entities')
      .select('id, entity_name, status, updated_at, request_id, requests(loan_number)')
      .eq('status', 'processing')
      .lt('updated_at', fortyEightHoursAgo) as { data: any[] | null; error: any };

    if (err3) console.error('Error querying processing entities:', err3.message);

    // Helper to calculate stuck duration
    const daysBetween = (dateStr: string): number => {
      return Math.floor((now.getTime() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
    };
    const hoursBetween = (dateStr: string): number => {
      return Math.floor((now.getTime() - new Date(dateStr).getTime()) / (1000 * 60 * 60));
    };

    // Map entities into structured objects
    const mapEntities = (entities: any[] | null, durationFn: (d: string) => string): StuckEntity[] => {
      return (entities || []).map((e: any) => ({
        entity_name: e.entity_name || 'Unknown Entity',
        loan_number: e.requests?.loan_number || 'N/A',
        updated_at: e.updated_at,
        stuckValue: durationFn(e.updated_at),
        expert_name: expertMap.get(e.id) || null,
        client_name: clientNameMap.get(e.request_id) || null,
      }));
    };

    const unsignedList = mapEntities(unsigned8821s, (d) => `${daysBetween(d)} days`);
    const waitingList = mapEntities(waitingForExpert, (d) => `${hoursBetween(d)} hours`);
    const stalledList = mapEntities(processingStalled, (d) => `${hoursBetween(d)} hours`);

    // Enrich stuck entities with expert assignment + client info
    const allStuckEntityIds = [
      ...(unsigned8821s || []),
      ...(waitingForExpert || []),
      ...(processingStalled || []),
    ].map((e: any) => e.id);

    // Fetch expert assignments for stuck entities
    let expertMap = new Map<string, string>();
    if (allStuckEntityIds.length > 0) {
      const { data: assignments } = await supabase
        .from('expert_assignments')
        .select('entity_id, expert_profile:profiles!expert_assignments_expert_id_fkey(full_name, email)')
        .in('entity_id', allStuckEntityIds)
        .in('status', ['assigned', 'in_progress']) as { data: any[] | null; error: any };

      (assignments || []).forEach((a: any) => {
        const name = a.expert_profile?.full_name || a.expert_profile?.email || 'Unassigned';
        expertMap.set(a.entity_id, name);
      });
    }

    // Fetch client names for stuck entities
    const allRequestIds = [
      ...(unsigned8821s || []),
      ...(waitingForExpert || []),
      ...(processingStalled || []),
    ].map((e: any) => e.request_id).filter(Boolean);

    let clientNameMap = new Map<string, string>();
    if (allRequestIds.length > 0) {
      const { data: requests } = await supabase
        .from('requests')
        .select('id, client_id, clients(name)')
        .in('id', Array.from(new Set(allRequestIds))) as { data: any[] | null; error: any };

      (requests || []).forEach((r: any) => {
        clientNameMap.set(r.id, r.clients?.name || 'Unknown');
      });
    }

    const totalStuck = unsignedList.length + waitingList.length + stalledList.length;

    // Skip if no stuck entities
    if (totalStuck === 0) {
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'No stuck entities found',
        processedAt: new Date().toISOString(),
      });
    }

    // Get all admin emails
    const { data: admins, error: adminsError } = await supabase
      .from('profiles')
      .select('id, email, full_name')
      .eq('role', 'admin')
      .not('email', 'is', null) as { data: { id: string; email: string; full_name: string | null }[] | null; error: any };

    if (adminsError || !admins || admins.length === 0) {
      console.error('No admins found or error:', adminsError);
      return NextResponse.json(
        { error: 'No admins found' },
        { status: 500 }
      );
    }

    // Build email HTML
    const buildSection = (
      title: string,
      emoji: string,
      entities: StuckEntity[],
      durationLabel: string
    ): string => {
      if (entities.length === 0) return '';
      const rows = entities
        .map(
          (e) =>
            `<tr>
              <td style="padding: 8px 12px; border-bottom: 1px solid #eee;">${e.entity_name}</td>
              <td style="padding: 8px 12px; border-bottom: 1px solid #eee;">${e.client_name || '—'}</td>
              <td style="padding: 8px 12px; border-bottom: 1px solid #eee;">${e.loan_number}</td>
              <td style="padding: 8px 12px; border-bottom: 1px solid #eee; font-weight: 600; color: ${e.expert_name ? '#0369a1' : '#dc2626'};">${e.expert_name || 'Unassigned'}</td>
              <td style="padding: 8px 12px; border-bottom: 1px solid #eee;">${e.stuckValue}</td>
            </tr>`
        )
        .join('');

      return `
        <div style="margin-bottom: 24px;">
          <h3 style="margin: 0 0 8px 0; font-size: 16px;">${emoji} ${title} (${entities.length})</h3>
          <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
            <thead>
              <tr style="background: #f5f5f5;">
                <th style="padding: 8px 12px; text-align: left;">Entity</th>
                <th style="padding: 8px 12px; text-align: left;">Client</th>
                <th style="padding: 8px 12px; text-align: left;">Loan #</th>
                <th style="padding: 8px 12px; text-align: left;">Expert</th>
                <th style="padding: 8px 12px; text-align: left;">${durationLabel}</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    };

    const emailHtml = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 700px; margin: 0 auto; padding: 24px;">
        <h2 style="margin: 0 0 4px 0; font-size: 20px;">Stuck Entity Alert</h2>
        <p style="margin: 0 0 24px 0; color: #666; font-size: 14px;">
          ${totalStuck} ${totalStuck === 1 ? 'entity needs' : 'entities need'} attention as of ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.
        </p>
        ${buildSection('Unsigned 8821s (5+ days)', '\uD83D\uDD34', unsignedList, 'Days Stuck')}
        ${buildSection('Waiting for Expert (48+ hours)', '\uD83D\uDFE1', waitingList, 'Hours Stuck')}
        ${buildSection('Processing Stalled (48+ hours)', '\uD83D\uDFE0', stalledList, 'Hours Stuck')}
        <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
        <p style="font-size: 12px; color: #999; margin: 0;">
          This is an automated alert from ModernTax. Log in to the admin dashboard to take action.
        </p>
      </div>`;

    // Send email via SendGrid
    const apiKey = process.env.SENDGRID_API_KEY;
    if (!apiKey) {
      console.error('SENDGRID_API_KEY not configured');
      return NextResponse.json(
        { error: 'SendGrid not configured' },
        { status: 500 }
      );
    }

    sgMail.setApiKey(apiKey);
    const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'notifications@moderntax.io';
    const subject = `[Action Required] ${totalStuck} ${totalStuck === 1 ? 'entity needs' : 'entities need'} attention`;

    let emailsSent = 0;
    const errors: { email: string; error: string }[] = [];

    for (const admin of admins) {
      try {
        await sgMail.send({
          to: admin.email,
          from: fromEmail,
          subject,
          html: emailHtml,
        });
        emailsSent++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        console.error(`Failed to send stuck entity alert to ${admin.email}:`, msg);
        errors.push({ email: admin.email, error: msg });
      }
    }

    return NextResponse.json({
      success: true,
      emailsSent,
      totalAdmins: admins.length,
      counts: {
        unsigned8821s: unsignedList.length,
        waitingForExpert: waitingList.length,
        processingStalled: stalledList.length,
        total: totalStuck,
      },
      processedAt: new Date().toISOString(),
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error('Stuck entity alert cron error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: 'Cron job failed', details: errorMessage },
      { status: 500 }
    );
  }
}
