/**
 * Daily 8821 Reminder Cron
 * Sends reminders to signers who haven't signed their 8821 after 24 hours
 * Runs daily at 9 AM ET via Vercel cron
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { sendReminder } from '@/lib/dropbox-sign';

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const supabase = createAdminClient();

    // Find entities in 8821_sent status with a signature_id, created > 24h ago
    const twentyFourHoursAgo = new Date();
    twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);

    const REMINDER_LIMIT = 100;
    const { data: pendingEntities, error } = await supabase
      .from('request_entities')
      .select('id, entity_name, signature_id, signer_email, created_at')
      .eq('status', '8821_sent')
      .not('signature_id', 'is', null)
      .not('signer_email', 'is', null)
      .lt('created_at', twentyFourHoursAgo.toISOString())
      .order('created_at', { ascending: true })
      .limit(REMINDER_LIMIT);

    if (error) {
      console.error('[8821-reminder] Query error:', error);
      return NextResponse.json({ error: 'Query failed' }, { status: 500 });
    }

    if (!pendingEntities || pendingEntities.length === 0) {
      console.log('[8821-reminder] No pending 8821s to remind');
      return NextResponse.json({ reminded: 0 });
    }

    if (pendingEntities.length === REMINDER_LIMIT) {
      console.warn(`[8821-reminder] Hit limit of ${REMINDER_LIMIT} entities — pagination may be needed`);
    }

    let reminded = 0;
    let failed = 0;

    for (const entity of pendingEntities) {
      try {
        await sendReminder(entity.signature_id!, entity.signer_email!);
        reminded++;
        console.log(`[8821-reminder] Reminder sent for ${entity.entity_name} → ${entity.signer_email}`);
      } catch (err) {
        failed++;
        console.error(`[8821-reminder] Failed to remind ${entity.entity_name}:`, err);
      }
    }

    console.log(`[8821-reminder] Done: ${reminded} reminded, ${failed} failed`);
    return NextResponse.json({ reminded, failed, total: pendingEntities.length });
  } catch (error) {
    console.error('[8821-reminder] Cron error:', error);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
