/**
 * Monitoring re-pull — bill on completion + notify the processor.
 *
 * Called from the expert completion path (upload-transcript) once a monitoring
 * re-pull entity is marked completed. A monitoring re-pull only covers the
 * years that were "no record of return filed" on the original order, so this
 * bills that pull — from the client's prepaid credit pool if they're a credit
 * client — EVEN IF the year is still no-record. Then it advances the
 * subscription's audit history and emails the initial processor with a
 * keep-or-deactivate choice for the next cycle.
 *
 * Fully best-effort: any failure is logged and swallowed so a completion never
 * fails because billing/notification did.
 */
import { noRecordYearsForEntity } from './no-record-monitoring';
import { sendMonitoringPullResult } from './sendgrid';

const DEFAULT_PER_PULL_FEE = 59.98;

export async function billMonitoringPullOnCompletion(admin: any, entityId: string): Promise<void> {
  try {
    // Load the completed re-pull entity with its fresh results.
    const { data: entity } = await admin
      .from('request_entities')
      .select('id, entity_name, years, transcript_urls, transcript_html_urls, gross_receipts, credit_paid, request_id')
      .eq('id', entityId)
      .single() as { data: any };
    if (!entity) return;

    const gr = entity.gross_receipts || {};
    const subId = gr.source_monitoring_id;
    if (!gr.monitoring_repull || !subId) return; // not a monitoring re-pull

    // Subscription + owning client.
    const { data: sub } = await admin
      .from('entity_monitoring')
      .select('id, client_id, per_pull_fee, total_pulls_completed, total_billed, pull_history, enrolled_by, status')
      .eq('id', subId)
      .single() as { data: any };
    if (!sub) return;

    const fee = Number(sub.per_pull_fee) > 0 ? Number(sub.per_pull_fee) : DEFAULT_PER_PULL_FEE;
    const monitoredYears: string[] = Array.isArray(gr.monitored_years) ? gr.monitored_years.map(String) : (entity.years || []).map(String);

    // Did any previously-missing year show up? Re-run the NRF detector on the
    // fresh result — years still returned by it are still no-record.
    const stillNoRecord = noRecordYearsForEntity(entity);
    const nowFiled = monitoredYears.filter((y) => !stillNoRecord.includes(y));

    // ── Bill: draw from the prepaid pool for credit clients (once) ────────────
    const { data: client } = await admin
      .from('clients')
      .select('id, name, credit_balance, credit_rate, credit_purchased_total')
      .eq('id', sub.client_id)
      .single() as { data: any };
    const isCredit = client && (Number(client.credit_purchased_total) || 0) > 0;

    if (isCredit && entity.credit_paid !== true) {
      const balance = Math.round(((Number(client.credit_balance) || 0) - fee) * 100) / 100;
      const { error: upErr } = await admin
        .from('request_entities')
        .update({ credit_paid: true })
        .eq('id', entityId)
        .eq('credit_paid', false);
      if (!upErr) {
        await admin.from('credit_ledger').insert({
          client_id: sub.client_id, kind: 'debit', amount: -fee, balance_after: balance,
          entity_id: entityId, note: `monitoring re-pull — ${entity.entity_name} (${monitoredYears.join(', ')})`,
        });
        await admin.from('clients').update({ credit_balance: balance }).eq('id', sub.client_id);
      }
    }
    // Non-credit (Mercury/ACH) clients are billed by the invoice cron, which
    // itemizes monitoring re-pulls per completed pull — no draw here.

    // ── Advance subscription audit history (billed either way) ────────────────
    const history = Array.isArray(sub.pull_history) ? sub.pull_history : [];
    history.push({
      date: new Date().toISOString().slice(0, 10),
      status: stillNoRecord.length ? 'no_record_found' : 'record_found',
      billable: true,
      billed_amount: fee,
      years: monitoredYears,
      new_entity_id: entityId,
    });
    await admin.from('entity_monitoring').update({
      last_pull_date: new Date().toISOString().slice(0, 10),
      total_pulls_completed: (Number(sub.total_pulls_completed) || 0) + 1,
      total_billed: Math.round(((Number(sub.total_billed) || 0) + fee) * 100) / 100,
      pull_history: history,
    }).eq('id', subId);

    // ── Notify the initial processor with keep/deactivate choice ──────────────
    if (sub.enrolled_by) {
      const { data: proc } = await admin.from('profiles').select('email').eq('id', sub.enrolled_by).single() as { data: any };
      const { data: srcReq } = await admin.from('request_entities').select('request_id').eq('id', gr.source_entity_id || entityId).single() as { data: any };
      if (proc?.email) {
        await sendMonitoringPullResult({
          to: proc.email, entityName: entity.entity_name, years: monitoredYears,
          nowFiledYears: nowFiled, stillNoRecordYears: stillNoRecord, billedAmount: fee,
          sourceRequestId: srcReq?.request_id || null,
        });
      }
    }
  } catch (err: any) {
    console.error('[billMonitoringPullOnCompletion] non-blocking failure:', err?.message);
  }
}
