'use client';

/**
 * LoanBillingForecast — inline cost preview on every intake form.
 *
 * Driver: 2026-05-28 Mathew Paek (Centerstone) renegotiation call —
 * "Jasmine's getting fed up... each invoice was different." Customers
 * need to see what they're going to be billed BEFORE they submit,
 * with every add-on a deliberate toggle and the running total live.
 * Solves the same pain Derek + Jasmine at Enterprise expressed
 * around cost predictability ("the bank has to absorb an expense
 * so we want to manage that").
 *
 * Designed to be dropped into CsvUploadFlow / ManualEntryFlow /
 * PdfUploadFlow / the new reorder-from-history flow — anywhere a
 * processor is about to create a request.
 *
 * Reads SKU prices live from INVOICE_SKU_CATALOG (lib/pricing.ts),
 * which the auto-invoice cron and the Stripe registration script
 * also read. Single source of truth.
 */

import { useMemo } from 'react';
import {
  INVOICE_SKU_CATALOG,
  CONSOLIDATION_REPORT_MIN_ENTITIES,
  fmtUsd,
} from '@/lib/pricing';

export interface LoanBillingForecastProps {
  /** Number of billable entities on this loan (excludes free trial / pre-billed). */
  entityCount: number;
  /**
   * Which verification tier the client is contracted at. Resolves to
   * the matching SKU in the catalog. Default = managed ($59.98).
   */
  verificationTier?: 'self-serve' | 'managed' | 'enterprise';
  /** Number of entities the processor wants enrolled in post-close monitoring. */
  monitoringEnrollmentCount: number;
  /** Whether the consolidation report is selected (loan-level). */
  consolidationReportSelected: boolean;
  /** Number of cash-flow packs selected (per-entity). */
  cashFlowPackCount?: number;
  /** Number of entity-transcript add-ons selected (per-entity). */
  entityTranscriptCount?: number;
  /**
   * Number of entities that are reorders (PRICE_REORDER instead of the
   * tier price). Subtracted from `entityCount` to avoid double-billing.
   */
  reorderCount?: number;
  /**
   * Toggles for the processor — when present, render checkboxes inline.
   * When omitted, the widget is read-only (e.g. inside a confirmation step).
   */
  onMonitoringChange?: (count: number) => void;
  onConsolidationReportChange?: (selected: boolean) => void;
  /**
   * When true, render a compact footer (single-line total) instead of the
   * full breakdown. Useful for the sticky-bottom version on long forms.
   */
  compact?: boolean;
}

const TIER_SKU: Record<NonNullable<LoanBillingForecastProps['verificationTier']>, string> = {
  'self-serve': 'verification-self-serve',
  'managed': 'verification-managed',
  'enterprise': 'verification-enterprise',
};

export function LoanBillingForecast({
  entityCount,
  verificationTier = 'managed',
  monitoringEnrollmentCount,
  consolidationReportSelected,
  cashFlowPackCount = 0,
  entityTranscriptCount = 0,
  reorderCount = 0,
  onMonitoringChange,
  onConsolidationReportChange,
  compact = false,
}: LoanBillingForecastProps) {
  const lines = useMemo(() => {
    const out: Array<{ label: string; sublabel?: string; amount: number; cadence: 'one_time' | 'monthly'; }> = [];

    const tierSku = INVOICE_SKU_CATALOG[TIER_SKU[verificationTier]];
    const newEntityCount = Math.max(0, entityCount - reorderCount);

    if (newEntityCount > 0) {
      out.push({
        label: tierSku.name,
        sublabel: `${newEntityCount} × ${fmtUsd(tierSku.unitPrice)} — ${verificationTier === 'self-serve'
          ? 'pre-signed 8821, you upload'
          : verificationTier === 'enterprise'
            ? 'same-day SLA, dedicated expert'
            : 'we handle the 8821 acquisition'}`,
        amount: newEntityCount * tierSku.unitPrice,
        cadence: 'one_time',
      });
    }

    if (reorderCount > 0) {
      const reorderSku = INVOICE_SKU_CATALOG['reorder-from-history'];
      out.push({
        label: reorderSku.name,
        sublabel: `${reorderCount} × ${fmtUsd(reorderSku.unitPrice)} — existing 8821 reused`,
        amount: reorderCount * reorderSku.unitPrice,
        cadence: 'one_time',
      });
    }

    if (entityTranscriptCount > 0) {
      const sku = INVOICE_SKU_CATALOG['entity-transcript-addon'];
      out.push({
        label: sku.name,
        sublabel: `${entityTranscriptCount} × ${fmtUsd(sku.unitPrice)} — confirms filing reqs first`,
        amount: entityTranscriptCount * sku.unitPrice,
        cadence: 'one_time',
      });
    }

    if (cashFlowPackCount > 0) {
      const sku = INVOICE_SKU_CATALOG['cash-flow-pack'];
      out.push({
        label: sku.name,
        sublabel: `${cashFlowPackCount} × ${fmtUsd(sku.unitPrice)} — DSCR + trend analysis`,
        amount: cashFlowPackCount * sku.unitPrice,
        cadence: 'one_time',
      });
    }

    if (consolidationReportSelected) {
      const sku = INVOICE_SKU_CATALOG['loan-consolidation-report'];
      out.push({
        label: sku.name,
        sublabel: `1 × ${fmtUsd(sku.unitPrice)} — single PDF/Excel for the underwriter`,
        amount: sku.unitPrice,
        cadence: 'one_time',
      });
    }

    if (monitoringEnrollmentCount > 0) {
      const sku = INVOICE_SKU_CATALOG['post-close-monitoring'];
      out.push({
        label: sku.name,
        sublabel: `${monitoringEnrollmentCount} × ${fmtUsd(sku.unitPrice)}/mo — auto-cancels when transcript lands`,
        amount: monitoringEnrollmentCount * sku.unitPrice,
        cadence: 'monthly',
      });
    }

    return out;
  }, [entityCount, reorderCount, verificationTier, entityTranscriptCount, cashFlowPackCount, consolidationReportSelected, monitoringEnrollmentCount]);

  const oneTimeTotal = lines.filter((l) => l.cadence === 'one_time').reduce((a, l) => a + l.amount, 0);
  const monthlyTotal = lines.filter((l) => l.cadence === 'monthly').reduce((a, l) => a + l.amount, 0);

  const showConsolidationOffer =
    entityCount >= CONSOLIDATION_REPORT_MIN_ENTITIES &&
    onConsolidationReportChange !== undefined;

  if (compact) {
    return (
      <div className="border border-gray-200 bg-gray-50 rounded-lg p-3 text-sm flex items-center justify-between">
        <span className="text-gray-700">Forecast (this loan):</span>
        <span className="font-semibold text-mt-dark">
          {fmtUsd(oneTimeTotal)}{monthlyTotal > 0 ? ` + ${fmtUsd(monthlyTotal)}/mo` : ''}
        </span>
      </div>
    );
  }

  return (
    <div className="border border-gray-200 bg-white rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-mt-dark">Billing forecast — this loan</h4>
        <span className="text-[11px] text-gray-500 italic">
          We bill end-of-month on completed work only
        </span>
      </div>

      {lines.length === 0 ? (
        <p className="text-xs text-gray-500 italic">
          No billable items yet — add entities or add-ons to see the forecast.
        </p>
      ) : (
        <ul className="space-y-1.5 text-xs">
          {lines.map((l, i) => (
            <li key={i} className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-gray-800">{l.label}</p>
                {l.sublabel && <p className="text-gray-500 text-[11px]">{l.sublabel}</p>}
              </div>
              <span className="font-mono text-gray-900 whitespace-nowrap">
                {fmtUsd(l.amount)}{l.cadence === 'monthly' ? '/mo' : ''}
              </span>
            </li>
          ))}
        </ul>
      )}

      {(oneTimeTotal > 0 || monthlyTotal > 0) && (
        <div className="border-t border-gray-200 pt-2.5 space-y-1">
          {oneTimeTotal > 0 && (
            <div className="flex items-center justify-between text-sm">
              <span className="font-semibold text-mt-dark">One-time total</span>
              <span className="font-mono font-semibold text-mt-dark">{fmtUsd(oneTimeTotal)}</span>
            </div>
          )}
          {monthlyTotal > 0 && (
            <div className="flex items-center justify-between text-sm">
              <span className="font-semibold text-mt-dark">Recurring (until cancel)</span>
              <span className="font-mono font-semibold text-mt-dark">{fmtUsd(monthlyTotal)}/mo</span>
            </div>
          )}
        </div>
      )}

      {/* Inline toggles — only render when the parent passed handlers */}
      {(onMonitoringChange || showConsolidationOffer) && (
        <div className="border-t border-gray-200 pt-3 space-y-2">
          <p className="text-[11px] uppercase tracking-wide text-gray-500 font-semibold">Add-ons</p>

          {onMonitoringChange && entityCount > 0 && (
            <label className="flex items-start gap-2 text-xs cursor-pointer hover:bg-gray-50 rounded px-1 py-1 -mx-1">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={monitoringEnrollmentCount > 0}
                onChange={(e) => onMonitoringChange(e.target.checked ? entityCount : 0)}
              />
              <span className="flex-1">
                <span className="font-medium text-gray-800">Enroll all {entityCount} entit{entityCount === 1 ? 'y' : 'ies'} in post-close monitoring</span>
                <span className="block text-gray-500 text-[11px]">
                  {fmtUsd(INVOICE_SKU_CATALOG['post-close-monitoring'].unitPrice)}/mo each. We re-poll the IRS monthly until the conditioned transcript lands. Auto-cancels — no manual unenroll needed.
                </span>
              </span>
            </label>
          )}

          {showConsolidationOffer && (
            <label className="flex items-start gap-2 text-xs cursor-pointer hover:bg-gray-50 rounded px-1 py-1 -mx-1">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={consolidationReportSelected}
                onChange={(e) => onConsolidationReportChange!(e.target.checked)}
              />
              <span className="flex-1">
                <span className="font-medium text-gray-800">Add the Loan-Package Consolidation Report</span>
                <span className="block text-gray-500 text-[11px]">
                  {fmtUsd(INVOICE_SKU_CATALOG['loan-consolidation-report'].unitPrice)} flat. One PDF + Excel consolidating findings across all {entityCount} entities for the underwriter — filing status, no-record-found years with reason codes, aggregate exposure.
                </span>
              </span>
            </label>
          )}
        </div>
      )}
    </div>
  );
}
