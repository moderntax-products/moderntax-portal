/**
 * POST /api/manager/convert-8821/generate
 *
 * Takes the (possibly-edited) extracted taxpayer info + the requested
 * tax years/form type and returns a ModernTax-designated 8821 PDF as
 * a download. No DB writes — this is a pure transform endpoint so the
 * manager can iterate on field corrections without polluting the DB.
 *
 * Body: JSON
 *   - taxpayer_name (req)
 *   - street_address, city, state, zip_code (combined into address)
 *   - tin (req)
 *   - tin_kind: 'EIN' | 'SSN' (defaults to EIN if blank)
 *   - taxpayer_phone (optional)
 *   - form_type: '1040' | '1065' | '1120' | '1120S' | '941' (defaults to 1120)
 *   - years: string (e.g. "2022-2026", "2020 through 2024", "2024,2025")
 *
 * Returns: application/pdf
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient } from '@/lib/supabase-server';
import { generate8821PDF, DESIGNEES } from '@/lib/8821-pdf';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = createServerRouteClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { data: profile } = await supabase
    .from('profiles').select('role').eq('id', user.id).single() as { data: any };
  if (!profile || !['manager', 'processor', 'admin'].includes(profile.role)) {
    return NextResponse.json({ error: 'Manager / processor / admin only' }, { status: 403 });
  }

  let body: any;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const taxpayer_name = (body.taxpayer_name || '').toString().trim();
  if (!taxpayer_name) return NextResponse.json({ error: 'taxpayer_name required' }, { status: 400 });

  const tin = (body.tin || '').toString().trim();
  if (!tin) return NextResponse.json({ error: 'tin required' }, { status: 400 });

  // Compose multi-line address (street / city,state zip) so the Section 1
  // overlay in lib/8821-pdf.ts renders cleanly.
  const street = (body.street_address || '').toString().trim();
  const city = (body.city || '').toString().trim();
  const state = (body.state || '').toString().trim().toUpperCase().slice(0, 2);
  const zip = (body.zip_code || '').toString().trim();
  const addressLine2 = [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const address = [street, addressLine2].filter(Boolean).join(', ');

  const phone = (body.taxpayer_phone || '').toString().trim();
  const allowedForms = ['1040', '1065', '1120', '1120S', '990', '1041', '941'] as const;
  type AllowedForm = typeof allowedForms[number];
  const rawForm = (body.form_type || '1120').toString().trim();
  const form_type: AllowedForm = (allowedForms as readonly string[]).includes(rawForm) ? rawForm as AllowedForm : '1120';
  const years = (body.years || '2022-2026').toString().trim();

  // House default designee for all auto-populated 8821s — Joel Abernathy as of
  // 2026-07-09 (DESIGNEES.default; was Matthew Parker, before that LaTonya).
  // The converted form gets re-signed carrying the designee whose queue the
  // pull actually lands in.
  const designee = DESIGNEES.default;

  try {
    const pdf = await generate8821PDF({
      taxpayer: { name: taxpayer_name, address, tin, phone },
      designee,
      formType: form_type,
      years,
    });

    const filename = `8821-ModernTax-${taxpayer_name.replace(/[^\w]+/g, '-').slice(0, 40)}.pdf`;
    return new NextResponse(pdf as any, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(pdf.length),
        // No caching — every regenerate is a fresh download.
        'Cache-Control': 'no-store',
      },
    });
  } catch (err: any) {
    console.error('[convert-8821/generate] Failed:', err);
    return NextResponse.json({
      error: 'PDF generation failed',
      details: err?.message || 'unknown',
    }, { status: 500 });
  }
}
