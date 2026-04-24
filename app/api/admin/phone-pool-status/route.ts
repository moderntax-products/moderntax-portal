/**
 * Live phone-pool status for the admin dashboard.
 *
 * GET /api/admin/phone-pool-status
 *   Requires CRON_SECRET OR admin auth session. Returns:
 *     • Every configured pool entry (phone + tz + label)
 *     • Whether each is currently inside IRS hours (area-code timezone)
 *     • The currently-picked from-number (what the next call would use)
 *     • Combined callable window summary for the day
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient } from '@/lib/supabase-server';
import { loadPhonePool, isIrsOpenFor, localHour, pickFromNumber } from '@/lib/phone-pool';

export async function GET(request: NextRequest) {
  // Allow either CRON_SECRET (for scheduled polling) or admin session.
  const auth = request.headers.get('authorization');
  const isCron = !!auth && auth === `Bearer ${process.env.CRON_SECRET}`;

  if (!isCron) {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
    if (!profile || (profile as any).role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  const now = new Date();
  const pool = loadPhonePool();
  const picked = pickFromNumber(pool, now);

  const entries = pool.map(p => {
    const hr = localHour(p.tz, now);
    const open = isIrsOpenFor(p.tz, now);
    return {
      phone: p.phone,
      label: p.label,
      tz: p.tz,
      area_code: p.area_code,
      local_hour: hr,
      open,
      is_picked: picked?.phone === p.phone,
    };
  });

  const anyOpen = entries.some(e => e.open);

  return NextResponse.json({
    now_utc: now.toISOString(),
    provider: process.env.CALL_PROVIDER || 'bland',
    pool_size: pool.length,
    any_open_now: anyOpen,
    picked: picked
      ? { phone: picked.phone, label: picked.label, tz: picked.tz }
      : null,
    entries,
    strategy:
      'IRS PPS honors business hours based on the CALLING area-code timezone. ' +
      'Our pool rotates across US timezones so the 4am-PT → 7pm-PT 15-hour window is always covered. ' +
      'pickFromNumber() selects the eligible entry with the most remaining local window.',
  });
}
