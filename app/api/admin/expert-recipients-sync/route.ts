/**
 * POST /api/admin/expert-recipients-sync
 *
 * Automates the Mercury recipient invite for EVERY expert. For each active
 * expert without a linked Mercury recipient, it first matches an existing
 * recipient by name/email (and links it), otherwise CREATES a Mercury recipient
 * from their name + email — Mercury then collects their bank details directly
 * (we never store banking info). Idempotent: experts already linked are skipped.
 *
 * Auth: admin only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { listMercuryRecipients, matchRecipient, createMercuryRecipient } from '@/lib/mercury';

export const runtime = 'nodejs';

export async function POST(_request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = createServerRouteClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const { data: caller } = await supabase.from('profiles').select('role').eq('id', user.id).single() as { data: { role: string } | null };
  if (!caller || caller.role !== 'admin') return NextResponse.json({ error: 'Admin only' }, { status: 403 });
  if (!process.env.MERCURY_API_KEY) return NextResponse.json({ error: 'MERCURY_API_KEY not configured' }, { status: 500 });

  const admin = createAdminClient();
  const { data: experts } = await admin.from('profiles')
    .select('id, full_name, email, mercury_recipient_id, approval_status')
    .eq('role', 'expert') as { data: any[] | null };
  const targets = (experts || []).filter(e =>
    e.email && !e.mercury_recipient_id && (e.approval_status === 'approved' || e.approval_status == null),
  );

  let recips;
  try { recips = await listMercuryRecipients(); }
  catch (e: any) { return NextResponse.json({ error: 'Could not reach Mercury', detail: e?.message }, { status: 502 }); }

  let created = 0, matched = 0;
  const results: { expert: string; action: string }[] = [];

  for (const ex of targets) {
    try {
      const m = matchRecipient(recips, ex.full_name, ex.email);
      let recipientId: string;
      if (m) { recipientId = m.id; matched++; results.push({ expert: ex.email, action: 'matched existing' }); }
      else {
        const r = await createMercuryRecipient(ex.full_name || ex.email, ex.email);
        recipientId = r.id;
        recips.push(r); // so a later duplicate-name expert matches this one
        created++;
        results.push({ expert: ex.email, action: 'created + invited' });
      }
      await (admin.from('profiles' as any) as any).update({ mercury_recipient_id: recipientId }).eq('id', ex.id);
    } catch (e: any) {
      results.push({ expert: ex.email, action: `FAILED: ${e?.message || e}` });
    }
  }

  return NextResponse.json({
    success: true,
    total_experts: (experts || []).length,
    needed_sync: targets.length,
    created,            // new recipients (Mercury invites them to add bank details)
    matched,            // linked to an existing Mercury recipient
    already_linked: (experts || []).length - targets.length,
    results,
  });
}
