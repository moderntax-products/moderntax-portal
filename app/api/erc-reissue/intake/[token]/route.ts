import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { ErcIntakeData } from '@/lib/erc-reissue';

/**
 * POST /api/erc-reissue/intake/[token]
 * Token-gated intake submission. Writes the intake JSON to the entity,
 * advances all attached reissue rows to 'intake_complete', and appends
 * an entry to each reissue's status_history.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { token: string } },
) {
  if (!params.token || params.token.length < 16) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 400 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // Resolve token → entity
  const { data: entity, error: entErr } = await supabase
    .from('request_entities')
    .select('id, entity_name, erc_intake_submitted_at')
    .eq('erc_intake_token', params.token)
    .maybeSingle();
  if (entErr || !entity) {
    // SOC 2 CC7.2 — log failed token lookups so enumeration attempts are
    // visible to monitoring (audit H2). Truncate the token in the log to
    // prevent log scrapers from re-using leaked tokens; the prefix is
    // enough to correlate with a specific attacker session.
    const ipHeader = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || '';
    const ip = ipHeader.split(',')[0]?.trim() || 'unknown';
    await supabase.from('audit_log').insert({
      user_email: null,
      action: 'erc_intake_bad_token',
      entity_type: 'request_entity',
      entity_id: null,
      details: {
        token_prefix: params.token.slice(0, 6),
        token_length: params.token.length,
        user_agent: request.headers.get('user-agent') || null,
      },
      ip_address: ip,
    }).then(({ error }) => {
      if (error) console.error('[AUDIT-LOG-FAILURE]', JSON.stringify({ action: 'erc_intake_bad_token', error: error.message }));
    });
    return NextResponse.json({ error: 'Link no longer valid' }, { status: 404 });
  }
  if (entity.erc_intake_submitted_at) {
    return NextResponse.json({ error: 'This intake form was already submitted.' }, { status: 409 });
  }

  // SOC 2 CC7.2 — bounded JSON body (intake form payloads are ~5KB; 64KB cap
  // is generous and prevents memory-DoS via giant payloads on this public route).
  const { parseJsonBodyOrRespond } = await import('@/lib/request-body');
  const parsed = await parseJsonBodyOrRespond(request, 64 * 1024);
  if (parsed instanceof NextResponse) return parsed;
  const payload: any = parsed;

  // Light validation
  const addr = payload?.new_mailing_address;
  if (!addr?.address1 || !addr?.city || !addr?.state || !addr?.zip) {
    return NextResponse.json({ error: 'New mailing address is incomplete' }, { status: 400 });
  }
  const officer = payload?.authorized_officer;
  if (!officer?.name || !officer?.title || !officer?.signature_typed) {
    return NextResponse.json({ error: 'Authorized officer info is incomplete' }, { status: 400 });
  }
  if (!payload?.consent_to_call_irs) {
    return NextResponse.json({ error: 'IRS contact consent is required' }, { status: 400 });
  }

  const submittedAt = new Date().toISOString();
  const intakeData: ErcIntakeData = {
    submitted_at: submittedAt,
    new_mailing_address: payload.new_mailing_address,
    authorized_officer: payload.authorized_officer,
    certification_box_per_quarter: payload.certification_box_per_quarter || {},
    consent_to_call_irs: payload.consent_to_call_irs,
    irs_2848_poa_on_file: !!payload.irs_2848_poa_on_file,
    additional_notes: payload.additional_notes || '',
  };

  // 1. Write intake to entity
  const { error: updErr } = await supabase
    .from('request_entities')
    .update({
      erc_intake_data: intakeData,
      erc_intake_submitted_at: submittedAt,
    })
    .eq('id', entity.id);
  if (updErr) {
    return NextResponse.json({ error: `Failed to save intake: ${updErr.message}` }, { status: 500 });
  }

  // 2. Advance every reissue row → 'intake_complete' + record certification box + append history
  const { data: reissues } = await supabase
    .from('erc_check_reissues')
    .select('id, tax_quarter, status_history, filing_status')
    .eq('entity_id', entity.id);

  for (const r of reissues || []) {
    const box = intakeData.certification_box_per_quarter?.[r.tax_quarter] || null;
    const history = Array.isArray(r.status_history) ? r.status_history : [];
    history.push({
      status: 'intake_complete',
      changed_at: submittedAt,
      changed_by: 'merchant',
      note_internal: `Intake submitted by ${officer.name} (${officer.title}). New mailing: ${addr.address1}, ${addr.city}, ${addr.state} ${addr.zip}. Cert box: ${box}.`,
      note_merchant_visible: 'Intake received — your case is ready for the expert call to the IRS on Monday morning.',
    });
    await supabase
      .from('erc_check_reissues')
      .update({
        certification_box: box,
        filing_status: 'intake_complete',
        status_history: history,
      })
      .eq('id', r.id);
  }

  // 3. Fire admin notification (fire-and-forget; don't block on it)
  try {
    const { sendErcAdminIntakeReceived } = await import('@/lib/sendgrid');
    await sendErcAdminIntakeReceived({
      adminEmail: process.env.ADMIN_EMAIL || 'matt@moderntax.io',
      entityName: entity.entity_name,
      entityId: entity.id,
      officer: { name: officer.name, title: officer.title, signatureDate: officer.signature_date },
      newMailingAddress: addr,
      quarters: (reissues || []).map(r => ({
        taxQuarter: r.tax_quarter,
        certificationBox: intakeData.certification_box_per_quarter?.[r.tax_quarter] || null,
      })),
      additionalNotes: intakeData.additional_notes || '',
    });
  } catch (notifyErr) {
    console.warn('Admin notification failed (non-blocking):', notifyErr);
  }

  return NextResponse.json({
    ok: true,
    entity_id: entity.id,
    submitted_at: submittedAt,
    reissues_updated: (reissues || []).length,
  });
}
