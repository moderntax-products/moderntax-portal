/**
 * POST /api/auth/qualify
 * Evaluates qualification answers before account creation.
 * No auth required — pre-signup endpoint.
 */
import { NextRequest, NextResponse } from 'next/server';
import { scoreQualification } from '@/lib/trial-score';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  let body: Record<string, string>;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const { qual_segment, qual_monthly_volume, qual_current_vendor, qual_team_size } = body;
  if (!qual_segment || !qual_monthly_volume) {
    return NextResponse.json({ error: 'qual_segment and qual_monthly_volume are required' }, { status: 400 });
  }

  const result = scoreQualification({
    qual_segment,
    qual_monthly_volume,
    qual_current_vendor: qual_current_vendor || null,
    qual_team_size: qual_team_size || null,
  });

  return NextResponse.json(result);
}
