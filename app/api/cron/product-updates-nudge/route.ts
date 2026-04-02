/**
 * Product Updates Nudge Cron Job
 * Sends latest product feature updates to processors with a nudge to submit requests
 * GET /api/cron/product-updates-nudge
 *
 * Expected to be called by Vercel Cron with CRON_SECRET in headers
 * Scheduled: First Wednesday of each month
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { sendProductUpdatesNudge } from '@/lib/sendgrid';
import type { ProductUpdate } from '@/lib/types';

/**
 * Latest product feature updates to communicate to processors.
 * Update this list whenever new features ship.
 */
const LATEST_UPDATES: ProductUpdate[] = [
  {
    title: 'Faster Transcript Turnaround',
    description:
      'We\'ve optimized our IRS processing pipeline — average turnaround times are now 30% faster for standard transcript requests.',
    tag: 'Performance',
  },
  {
    title: 'Employment Verification via W-2 Income',
    description:
      'You can now request W-2 income verification alongside standard tax transcripts. Select "Employment" as the product type when submitting.',
    tag: 'New Feature',
  },
  {
    title: 'Bulk CSV Upload Improvements',
    description:
      'CSV uploads now support larger batches with better error reporting. Column validation catches issues before processing begins.',
    tag: 'Enhancement',
  },
  {
    title: 'Real-Time Status Notifications',
    description:
      'Get notified as soon as your transcripts are ready. Completion emails now include compliance scores and direct download links.',
    tag: 'Enhancement',
  },
];

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

    // Get all processors
    const { data: processors, error: usersError } = await supabase
      .from('profiles')
      .select('id, email, full_name, role, client_id')
      .eq('role', 'processor')
      .not('email', 'is', null) as {
      data: { id: string; email: string; full_name: string | null; role: string; client_id: string | null }[] | null;
      error: any;
    };

    if (usersError || !processors) {
      console.error('Failed to fetch processors:', usersError);
      return NextResponse.json(
        { error: 'Failed to fetch processors' },
        { status: 500 }
      );
    }

    // Get client names
    const clientIds = [...new Set(processors.map((p) => p.client_id).filter(Boolean))];
    const { data: clients } = await supabase
      .from('clients')
      .select('id, name')
      .in('id', clientIds as string[]) as { data: { id: string; name: string }[] | null; error: any };

    const clientMap: Record<string, string> = {};
    if (clients) {
      clients.forEach((c) => {
        clientMap[c.id] = c.name;
      });
    }

    let emailsSent = 0;
    const errors: { email: string; error: string }[] = [];

    for (const processor of processors) {
      try {
        // Get count of pending requests for this processor
        const { count: pendingCount } = await supabase
          .from('requests')
          .select('id', { count: 'exact', head: true })
          .eq('requested_by', processor.id)
          .not('status', 'in', '("completed","failed")');

        const clientName = processor.client_id
          ? clientMap[processor.client_id] || 'Your Organization'
          : 'Your Organization';

        await sendProductUpdatesNudge(
          processor.email,
          processor.full_name || 'Team Member',
          clientName,
          LATEST_UPDATES,
          pendingCount || 0
        );

        emailsSent++;
      } catch (userError) {
        const errorMessage = userError instanceof Error ? userError.message : 'Unknown error';
        console.error(`Error sending product updates to ${processor.email}:`, errorMessage);
        errors.push({ email: processor.email, error: errorMessage });
      }
    }

    return NextResponse.json({
      success: true,
      emailsSent,
      totalProcessors: processors.length,
      processedAt: new Date().toISOString(),
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error('Product updates nudge cron error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: 'Cron job failed', details: errorMessage },
      { status: 500 }
    );
  }
}
