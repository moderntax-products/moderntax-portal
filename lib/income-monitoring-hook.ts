/**
 * Income Monitoring — capture-on-completion + variance-alert wiring.
 *
 * Called from:
 *   • /api/expert/upload-transcript route, right after status='completed'
 *   • monitoring-repull cron, after clone completes
 *   • Backfill script for historical entities
 *
 * Per-entity sequence:
 *   1. Pull every .html transcript on file for the entity (uploads bucket).
 *   2. Pick the most-recent annual return transcript (1120/1120-S/1065/1040)
 *      — that's where the income figures live; 941 quarterlies don't carry
 *      these fields.
 *   3. Extract IncomeSnapshot via lib/income-reconciliation.
 *   4. Look up any prior entity for (client_id, tid) with income_snapshot
 *      already set. Earliest one = baseline (income_baseline column from
 *      that row, or its own snapshot if it's the first).
 *   5. Persist: income_snapshot = THIS pull's snapshot, income_baseline =
 *      either the prior baseline OR self (first pull).
 *   6. If baseline ≠ snapshot (subsequent pull) → run comparison.
 *      MATERIAL severity → send alert email to client managers.
 *
 * Best-effort: errors from this hook MUST NOT block the entity completion
 * flow. The upload-transcript route catches and logs.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  extractIncomeSnapshot,
  compareIncomeSnapshots,
  type IncomeSnapshot,
  type ReconciliationResult,
} from './income-reconciliation';

export interface CaptureResult {
  /** True when this is the first pull for (client_id, TID) — we just established the baseline. */
  baselineEstablished: boolean;
  /** The snapshot we just persisted for this entity. */
  snapshot: IncomeSnapshot | null;
  /** Comparison vs baseline. Only present when this isn't the first pull. */
  variance: ReconciliationResult | null;
  /** Whether an alert email was sent (only fires on MATERIAL severity). */
  alertSent: boolean;
  /** Human-readable reason if we skipped (e.g. "no income-bearing transcripts on file"). */
  skipReason: string | null;
}

/**
 * Process income monitoring for a single entity that just transitioned
 * to status='completed'. Idempotent — safe to call repeatedly.
 */
export async function captureEntityIncome(
  entityId: string,
  admin: SupabaseClient,
): Promise<CaptureResult> {
  // 1. Load entity + parent request for the TID + client_id context
  const { data: entity, error: lookupErr } = await admin
    .from('request_entities')
    .select(`
      id, entity_name, tid, form_type, transcript_html_urls, transcript_urls,
      income_baseline, income_snapshot, completed_at,
      requests(id, client_id, clients(name, billing_email))
    `)
    .eq('id', entityId)
    .single() as { data: any; error: any };

  if (lookupErr || !entity) {
    return skipResult('entity not found');
  }
  if (!entity.tid) {
    return skipResult('entity has no TID');
  }
  const clientId = entity.requests?.client_id;
  if (!clientId) {
    return skipResult('entity has no client linkage');
  }

  // 2. Pick HTML transcripts. Only annual return-bearing forms have income
  //    figures we can baseline against. Quarterly 941s carry employment-tax
  //    figures but not the AGI / gross receipts fields we want.
  const incomeBearingForms = ['1120', '1120S', '1120-S', '1065', '1040'];
  if (entity.form_type && !incomeBearingForms.includes(entity.form_type)) {
    return skipResult(`form_type ${entity.form_type} is not income-bearing (only 1120/1120-S/1065/1040)`);
  }

  const urls = Array.from(new Set([
    ...(entity.transcript_urls || []),
    ...(entity.transcript_html_urls || []),
  ])).filter((u: string) => u.endsWith('.html'));
  if (urls.length === 0) return skipResult('no HTML transcripts on file');

  // 3. Download each + extract snapshot from the highest tax-year transcript
  //    (most recent return is the one that should baseline the loan).
  const candidates: { taxYear: string; source: string; snapshot: IncomeSnapshot | null }[] = [];
  for (const u of urls as string[]) {
    const { data: f } = await admin.storage.from('uploads').download(u);
    if (!f) continue;
    const html = await f.text();
    // Quick year extraction — IRS HTML "Report for Tax Period Ending: MM-DD-YYYY"
    const yearMatch = html.match(/Report for Tax Period Ending:?[\s\S]{0,200}?<dd[^>]*>(\d{2}-\d{2}-(\d{4}))<\/dd>/i);
    const taxYear = yearMatch ? yearMatch[2] : '';
    if (!taxYear) continue;
    const snap = extractIncomeSnapshot(html, taxYear, u.split('/').pop() || u);
    if (snap) candidates.push({ taxYear, source: u, snapshot: snap });
  }
  if (candidates.length === 0) return skipResult('no income-bearing snapshot extractable from on-file transcripts');

  // Pick the highest tax year as the "current" snapshot.
  candidates.sort((a, b) => b.taxYear.localeCompare(a.taxYear));
  const currentSnapshot = candidates[0].snapshot!;

  // 4. Find prior entity for (client_id, TID) with income_snapshot — earliest one is the baseline source.
  const { data: priors } = await admin
    .from('request_entities')
    .select('id, income_baseline, income_snapshot, completed_at')
    .eq('tid', entity.tid)
    .not('income_snapshot', 'is', null)
    .neq('id', entityId)
    .order('completed_at', { ascending: true })
    .limit(1) as { data: any[] | null };

  let baselineSnapshot: IncomeSnapshot;
  let isFirstPull = false;
  if (priors && priors.length > 0) {
    // Baseline = the earliest prior pull's baseline (or its snapshot if it's the first ever).
    baselineSnapshot = priors[0].income_baseline || priors[0].income_snapshot;
  } else {
    // First pull for this TID — this is the baseline. Both fields equal the same snapshot.
    isFirstPull = true;
    baselineSnapshot = currentSnapshot;
  }

  // 5. Persist
  const { error: updErr } = await admin
    .from('request_entities')
    .update({
      income_baseline: baselineSnapshot,
      income_snapshot: currentSnapshot,
    })
    .eq('id', entityId);
  if (updErr) {
    console.error('[income-monitoring-hook] persist failed:', updErr);
    return skipResult('failed to persist snapshot: ' + updErr.message);
  }

  // 6. Compare + alert if MATERIAL on subsequent pulls
  let variance: ReconciliationResult | null = null;
  let alertSent = false;
  if (!isFirstPull) {
    variance = compareIncomeSnapshots(baselineSnapshot, currentSnapshot);
    if (variance.overallSeverity === 'MATERIAL') {
      try {
        const { sendIncomeVarianceAlert } = await import('./sendgrid');
        // Find client managers to alert
        const { data: managers } = await admin
          .from('profiles')
          .select('email, full_name')
          .eq('client_id', clientId)
          .in('role', ['manager']);
        const recipients = (managers || []).map((m: any) => m.email).filter(Boolean);
        if (recipients.length > 0) {
          await sendIncomeVarianceAlert({
            recipients,
            entityName: entity.entity_name,
            clientName: entity.requests?.clients?.name || 'Unknown',
            entityId,
            variance,
          });
          alertSent = true;
        }
      } catch (emailErr) {
        console.error('[income-monitoring-hook] alert email failed:', emailErr);
      }
    }
  }

  return {
    baselineEstablished: isFirstPull,
    snapshot: currentSnapshot,
    variance,
    alertSent,
    skipReason: null,
  };
}

function skipResult(reason: string): CaptureResult {
  return {
    baselineEstablished: false,
    snapshot: null,
    variance: null,
    alertSent: false,
    skipReason: reason,
  };
}
