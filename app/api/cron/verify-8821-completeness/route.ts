/**
 * Cron: verify-8821-completeness
 * GET /api/cron/verify-8821-completeness
 *
 * Pre-assignment gate for UPLOADED 8821s (Centerstone flat-rate bulk-attach +
 * single-PDF fallback). Vision-reads each entity's attached 8821 and confirms
 * it's complete — right taxpayer TIN, signed, ModernTax named as designee —
 * before auto-assign-experts will hand it to an expert. Stamps the verdict on
 * gross_receipts.eightyone_check; on a hard failure it posts a note flagging
 * the exact problem so the processor can re-upload. Idempotent: skips entities
 * already verified against the current file; re-checks on re-upload or after an
 * inconclusive (vision-outage) result.
 *
 * App-generated 8821s (Dropbox Sign → signature_id present), API intake, and
 * W2_INCOME are inherently fine and are skipped.
 *
 * Auth: Vercel cron Bearer secret (CRON_SECRET). Cadence: every 10 minutes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';
import { verify8821Complete } from '@/lib/verify-8821-complete';

export const runtime = 'nodejs';
export const maxDuration = 300;

// Vision is ~3-5s per PDF; keep the batch under maxDuration.
const MAX_PER_RUN = 25;

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  try {
    const supabase = createAdminClient();

    // Uploaded-8821 entities awaiting assignment. signature_id null → not a
    // Dropbox-Sign (app-generated) form; those don't need re-verification.
    const { data: rows } = await supabase
      .from('request_entities')
      .select('id, entity_name, tid, form_type, status, signed_8821_url, signature_id, gross_receipts, request_id')
      .in('status', ['8821_signed', 'irs_queue'])
      .not('signed_8821_url', 'is', null)
      .is('signature_id', null)
      .order('created_at', { ascending: true })
      .limit(300) as { data: any[] | null };

    if (!rows || rows.length === 0) {
      return NextResponse.json({ ok: true, checked: 0, note: 'no uploaded 8821s pending verification' });
    }

    // Drop API-intake entities (they skip the 8821 flow).
    const reqIds = [...new Set(rows.map((r) => r.request_id))];
    const { data: reqs } = await supabase
      .from('requests').select('id, intake_method, client_id').in('id', reqIds) as { data: any[] | null };
    const apiReqIds = new Set((reqs || []).filter((r) => r.intake_method === 'api').map((r) => r.id));

    // Needs verification: not yet checked against THIS file, or last result was
    // inconclusive (vision outage).
    const candidates = rows.filter((e) => {
      if (e.form_type === 'W2_INCOME' || apiReqIds.has(e.request_id)) return false;
      const chk = e.gross_receipts?.eightyone_check;
      if (!chk) return true;
      if (chk.inconclusive) return true;
      return chk.checked_url !== e.signed_8821_url; // re-uploaded since last check
    }).slice(0, MAX_PER_RUN);

    let passed = 0, failed = 0, inconclusive = 0;
    const results: Array<{ entity: string; ok: boolean; reason: string }> = [];
    const nowIso = new Date().toISOString();

    for (const e of candidates) {
      const { data: blob, error: dlErr } = await supabase.storage.from('uploads').download(e.signed_8821_url);
      if (dlErr || !blob) {
        console.warn(`[verify-8821] download failed for ${e.entity_name} (${e.signed_8821_url}): ${dlErr?.message || ''}`);
        continue; // leave unverified; retry next run
      }
      const buf = Buffer.from(await blob.arrayBuffer());
      const v = await verify8821Complete(buf, e.tid);

      const check = {
        ok: v.ok,
        tin_match: v.tinMatch,
        signed: v.signed,
        designee_ok: v.designeeOk,
        extracted_tin_last4: v.extractedTin ? v.extractedTin.slice(-4) : null,
        inconclusive: v.inconclusive,
        reason: v.reason,
        checked_at: nowIso,
        checked_url: e.signed_8821_url,
      };
      await (supabase.from('request_entities') as any)
        .update({ gross_receipts: { ...(e.gross_receipts || {}), eightyone_check: check } })
        .eq('id', e.id);

      if (v.inconclusive) { inconclusive++; results.push({ entity: e.entity_name, ok: false, reason: v.reason }); continue; }

      if (v.ok) {
        passed++;
        results.push({ entity: e.entity_name, ok: true, reason: 'complete' });
      } else {
        failed++;
        results.push({ entity: e.entity_name, ok: false, reason: v.reason });
        // Flag it so the processor can fix + re-upload. De-dupe by only posting
        // when there isn't already an open flag note for this file.
        try {
          const body = `⚠️ 8821 not complete — held from assignment. ${v.reason}. Please re-upload a complete, signed 8821 for ${e.entity_name} (TIN …${(e.tid || '').replace(/\D/g, '').slice(-4)}) naming ModernTax (CAF 0316-30210R) as designee.`;
          await (supabase.from('entity_notes') as any).insert({
            entity_id: e.id, author_id: null, author_role: 'admin',
            author_name: 'ModernTax 8821 Check', body, kind: 'instruction',
          });
        } catch (noteErr) {
          console.warn(`[verify-8821] flag note failed for ${e.id}:`, noteErr);
        }
      }
      console.log(`[verify-8821] ${e.entity_name}: ${v.ok ? 'COMPLETE' : v.inconclusive ? 'INCONCLUSIVE' : 'INCOMPLETE'} — ${v.reason}`);
    }

    return NextResponse.json({
      ok: true,
      candidates: candidates.length,
      passed, failed, inconclusive,
      results,
    });
  } catch (err) {
    console.error('[verify-8821] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'verify-8821 sweep failed' },
      { status: 500 },
    );
  }
}
