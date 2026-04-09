/**
 * Expert Daily Call Schedule Cron
 * Runs every weekday morning (6:30 AM ET / 10:30 UTC)
 *
 * For each expert with pending assignments:
 * 1. Creates a unique schedule token for today
 * 2. Sends an email with pending entities and time slot buttons
 * 3. Expert clicks a time → schedule page → confirms → call is scheduled
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { sendExpertDailyCallSchedule } from '@/lib/sendgrid';
import { randomUUID } from 'crypto';

export const maxDuration = 30;

export async function GET(request: NextRequest) {
  try {
    // Validate CRON_SECRET
    const cronSecret = request.headers.get('Authorization');
    const expectedSecret = process.env.CRON_SECRET;

    if (!cronSecret || !expectedSecret || cronSecret !== `Bearer ${expectedSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const supabase = createAdminClient();
    const now = new Date();
    const today = now.toISOString().split('T')[0];

    // Check if weekday (IRS PPS closed weekends)
    const etTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const day = etTime.getDay();
    if (day === 0 || day === 6) {
      return NextResponse.json({ success: true, message: 'Weekend — no emails sent', skipped: true });
    }

    // Find all experts with pending assignments
    const { data: experts } = await supabase
      .from('profiles')
      .select('id, full_name, email, phone_number, caf_number')
      .eq('role', 'expert') as { data: any[] | null };

    if (!experts || experts.length === 0) {
      return NextResponse.json({ success: true, message: 'No experts found', sent: 0 });
    }

    let sent = 0;
    let skipped = 0;
    const results: { expert: string; status: string }[] = [];

    for (const expert of experts) {
      try {
        // Skip experts without CAF
        if (!expert.caf_number) {
          skipped++;
          results.push({ expert: expert.full_name, status: 'no_caf' });
          continue;
        }

        // Check if we already sent a token today
        const { data: existingToken } = await supabase
          .from('expert_schedule_tokens' as any)
          .select('id')
          .eq('expert_id', expert.id)
          .eq('schedule_date', today)
          .single() as { data: any; error: any };

        if (existingToken) {
          skipped++;
          results.push({ expert: expert.full_name, status: 'already_sent' });
          continue;
        }

        // Get pending assignments
        const { data: assignments } = await supabase
          .from('expert_assignments')
          .select('id, entity_id, created_at, request_entities(entity_name, tid_kind, form_type, years)')
          .eq('expert_id', expert.id)
          .in('status', ['assigned', 'in_progress']) as { data: any[] | null };

        if (!assignments || assignments.length === 0) {
          skipped++;
          results.push({ expert: expert.full_name, status: 'no_assignments' });
          continue;
        }

        // Generate token
        const token = randomUUID();

        // Create token record
        await supabase.from('expert_schedule_tokens' as any).insert({
          expert_id: expert.id,
          token,
          schedule_date: today,
          status: 'pending',
          entity_count: assignments.length,
        });

        // Build entity list for email
        const pendingEntities = assignments.map((a: any) => {
          const daysSinceAssigned = Math.floor(
            (now.getTime() - new Date(a.created_at).getTime()) / (1000 * 60 * 60 * 24)
          );
          return {
            entityName: a.request_entities?.entity_name || 'Unknown',
            tidKind: a.request_entities?.tid_kind || 'EIN',
            formType: a.request_entities?.form_type || '—',
            years: a.request_entities?.years || [],
            assignmentId: a.id,
            daysAssigned: daysSinceAssigned,
          };
        });

        // Send the email
        await sendExpertDailyCallSchedule(
          expert.email,
          expert.full_name,
          expert.id,
          pendingEntities,
          token
        );

        sent++;
        results.push({ expert: expert.full_name, status: 'sent' });

      } catch (expertErr) {
        console.error(`Failed to send schedule email to ${expert.full_name}:`, expertErr);
        results.push({ expert: expert.full_name, status: 'error' });
      }
    }

    // Expire old unused tokens
    await supabase
      .from('expert_schedule_tokens' as any)
      .update({ status: 'expired' })
      .eq('status', 'pending')
      .lt('schedule_date', today);

    return NextResponse.json({
      success: true,
      sent,
      skipped,
      results,
      processedAt: now.toISOString(),
    });
  } catch (error) {
    console.error('Expert daily call schedule cron error:', error);
    return NextResponse.json(
      { error: 'Cron failed', details: error instanceof Error ? error.message : 'Unknown' },
      { status: 500 }
    );
  }
}
