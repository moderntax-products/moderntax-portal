/**
 * Hourly Admin Pipeline Status Cron
 * Sends admins a FIFO-ordered list of incomplete requests so nothing falls through the cracks.
 * GET /api/cron/admin-pipeline-status
 *
 * Runs every hour. Shows oldest-first requests that are NOT completed/failed,
 * grouped by status stage with age and entity counts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';

const sgMail = require('@sendgrid/mail');

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const supabase = createAdminClient();

    // Get all incomplete requests ordered by creation date (FIFO)
    const { data: requests, error: reqError } = await supabase
      .from('requests')
      .select(`
        id, loan_number, status, created_at, client_id,
        clients(name),
        profiles!requests_requested_by_fkey(full_name, email)
      `)
      .not('status', 'in', '("completed","failed","cancelled")')
      .order('created_at', { ascending: true })
      .limit(100) as { data: any[] | null; error: any };

    if (reqError) {
      console.error('[admin-pipeline-status] Failed to fetch requests:', reqError);
      return NextResponse.json({ error: 'Query failed' }, { status: 500 });
    }

    if (!requests || requests.length === 0) {
      console.log('[admin-pipeline-status] No incomplete requests — skipping email');
      return NextResponse.json({ success: true, sent: false, message: 'No incomplete requests' });
    }

    // Get entity counts and status breakdown per request
    const requestIds = requests.map((r: any) => r.id);
    const { data: entities } = await supabase
      .from('request_entities')
      .select('id, request_id, status, entity_name, created_at')
      .in('request_id', requestIds) as { data: any[] | null; error: any };

    // Group entities by request
    const entityMap = new Map<string, any[]>();
    (entities || []).forEach((e: any) => {
      if (!entityMap.has(e.request_id)) entityMap.set(e.request_id, []);
      entityMap.get(e.request_id)!.push(e);
    });

    // Get expert assignments for these entities
    const entityIds = (entities || []).map((e: any) => e.id);
    const { data: assignments } = await supabase
      .from('expert_assignments')
      .select('entity_id, expert_id, status, profiles!expert_assignments_expert_id_fkey(full_name)')
      .in('entity_id', entityIds)
      .in('status', ['assigned', 'in_progress']) as { data: any[] | null; error: any };

    const assignmentMap = new Map<string, any>();
    (assignments || []).forEach((a: any) => {
      assignmentMap.set(a.entity_id, a);
    });

    // Build the email rows
    const now = new Date();
    const rows = requests.map((req: any, index: number) => {
      const reqEntities = entityMap.get(req.id) || [];
      const totalEntities = reqEntities.length;
      const completedEntities = reqEntities.filter((e: any) => e.status === 'completed').length;
      const pendingEntities = reqEntities.filter((e: any) => !['completed', 'failed'].includes(e.status));

      const createdAt = new Date(req.created_at);
      const ageHours = Math.round((now.getTime() - createdAt.getTime()) / (1000 * 60 * 60));
      const ageDays = Math.floor(ageHours / 24);
      const ageDisplay = ageDays > 0 ? `${ageDays}d ${ageHours % 24}h` : `${ageHours}h`;

      // Color code by age
      const ageColor = ageDays >= 3 ? '#dc2626' : ageDays >= 1 ? '#d97706' : '#059669';

      // Status badge color
      const statusColors: Record<string, string> = {
        pending: '#6b7280',
        '8821_sent': '#3b82f6',
        '8821_signed': '#8b5cf6',
        irs_queue: '#f59e0b',
        in_progress: '#f97316',
      };
      const statusColor = statusColors[req.status] || '#6b7280';

      // Entity detail lines
      const entityLines = pendingEntities.slice(0, 5).map((e: any) => {
        const assignment = assignmentMap.get(e.id);
        const expertName = assignment?.profiles?.full_name || 'Unassigned';
        return `<span style="color: #6b7280; font-size: 11px;">&bull; ${e.entity_name} — <em>${e.status}</em> (${expertName})</span>`;
      }).join('<br>');

      const moreCount = pendingEntities.length > 5 ? pendingEntities.length - 5 : 0;

      return `
        <tr style="border-bottom: 1px solid #f3f4f6;">
          <td style="padding: 10px 8px; font-size: 13px; color: #374151; text-align: center;">${index + 1}</td>
          <td style="padding: 10px 8px;">
            <strong style="font-size: 13px; color: #111827;">${req.loan_number || req.id.slice(0, 8)}</strong>
            <br><span style="font-size: 11px; color: #6b7280;">${(req.clients as any)?.name || 'Unknown'} &middot; ${(req.profiles as any)?.full_name || (req.profiles as any)?.email || 'N/A'}</span>
          </td>
          <td style="padding: 10px 8px; text-align: center;">
            <span style="background: ${statusColor}15; color: ${statusColor}; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 9999px;">${req.status}</span>
          </td>
          <td style="padding: 10px 8px; text-align: center; font-size: 13px;">
            <strong>${completedEntities}</strong><span style="color: #9ca3af;">/${totalEntities}</span>
          </td>
          <td style="padding: 10px 8px; text-align: center;">
            <span style="color: ${ageColor}; font-weight: 600; font-size: 13px;">${ageDisplay}</span>
          </td>
          <td style="padding: 10px 8px; font-size: 11px;">
            ${entityLines}${moreCount > 0 ? `<br><span style="color: #9ca3af; font-size: 10px;">+${moreCount} more</span>` : ''}
          </td>
        </tr>`;
    }).join('');

    // Summary stats
    const totalIncomplete = requests.length;
    const staleCount = requests.filter((r: any) => {
      const age = (now.getTime() - new Date(r.created_at).getTime()) / (1000 * 60 * 60 * 24);
      return age >= 3;
    }).length;

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io';

    const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto;">
  <div style="background: #1a1a2e; color: white; padding: 20px 24px; border-radius: 8px 8px 0 0;">
    <h1 style="margin: 0; font-size: 18px;">Pipeline Status Update</h1>
    <p style="margin: 4px 0 0; opacity: 0.7; font-size: 13px;">Hourly FIFO Report &middot; ${now.toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' })} ET</p>
  </div>

  <div style="padding: 20px 24px; background: #fff; border: 1px solid #e5e7eb; border-top: none;">
    <div style="display: flex; gap: 24px; margin-bottom: 20px;">
      <div style="text-align: center; flex: 1; padding: 12px; background: #f9fafb; border-radius: 8px;">
        <div style="font-size: 28px; font-weight: 700; color: #111827;">${totalIncomplete}</div>
        <div style="font-size: 11px; color: #6b7280; text-transform: uppercase;">Incomplete</div>
      </div>
      <div style="text-align: center; flex: 1; padding: 12px; background: ${staleCount > 0 ? '#fef2f2' : '#f0fdf4'}; border-radius: 8px;">
        <div style="font-size: 28px; font-weight: 700; color: ${staleCount > 0 ? '#dc2626' : '#059669'};">${staleCount}</div>
        <div style="font-size: 11px; color: #6b7280; text-transform: uppercase;">Stale (3+ days)</div>
      </div>
    </div>

    <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
      <thead>
        <tr style="background: #f9fafb; border-bottom: 2px solid #e5e7eb;">
          <th style="padding: 8px; text-align: center; font-size: 11px; color: #6b7280; text-transform: uppercase;">#</th>
          <th style="padding: 8px; text-align: left; font-size: 11px; color: #6b7280; text-transform: uppercase;">Request</th>
          <th style="padding: 8px; text-align: center; font-size: 11px; color: #6b7280; text-transform: uppercase;">Status</th>
          <th style="padding: 8px; text-align: center; font-size: 11px; color: #6b7280; text-transform: uppercase;">Done</th>
          <th style="padding: 8px; text-align: center; font-size: 11px; color: #6b7280; text-transform: uppercase;">Age</th>
          <th style="padding: 8px; text-align: left; font-size: 11px; color: #6b7280; text-transform: uppercase;">Entities</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>

    ${requests.length >= 100 ? '<p style="color: #d97706; font-size: 12px; margin-top: 12px;">Showing first 100 requests. Visit the dashboard for the full list.</p>' : ''}
  </div>

  <div style="padding: 16px 24px; background: #f9fafb; border-radius: 0 0 8px 8px; border: 1px solid #e5e7eb; border-top: none; text-align: center;">
    <a href="${appUrl}/admin" style="display: inline-block; background: #1a1a2e; color: white; padding: 10px 28px; border-radius: 6px; text-decoration: none; font-size: 13px; font-weight: 600;">Open Admin Dashboard</a>
    <p style="color: #9ca3af; font-size: 11px; margin: 8px 0 0;">ModernTax Pipeline Monitor &middot; Sent hourly</p>
  </div>
</div>`.trim();

    // Send to all admins
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    const { data: admins } = await supabase
      .from('profiles')
      .select('email')
      .eq('role', 'admin') as { data: { email: string }[] | null; error: any };

    let sent = 0;
    for (const admin of (admins || [])) {
      try {
        await sgMail.send({
          to: admin.email,
          from: { email: process.env.SENDGRID_FROM_EMAIL || 'notifications@moderntax.io', name: 'ModernTax' },
          subject: `Pipeline Status: ${totalIncomplete} incomplete${staleCount > 0 ? ` (${staleCount} stale)` : ''} — ${now.toLocaleDateString('en-US', { timeZone: 'America/New_York' })}`,
          html,
          replyTo: 'support@moderntax.io',
        });
        sent++;
      } catch (emailErr) {
        console.error(`[admin-pipeline-status] Failed to email ${admin.email}:`, emailErr);
      }
    }

    console.log(`[admin-pipeline-status] Sent to ${sent} admins — ${totalIncomplete} incomplete, ${staleCount} stale`);

    return NextResponse.json({
      success: true,
      sent: sent > 0,
      admins: sent,
      incomplete: totalIncomplete,
      stale: staleCount,
      processedAt: now.toISOString(),
    });
  } catch (error) {
    console.error('[admin-pipeline-status] Cron error:', error);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
