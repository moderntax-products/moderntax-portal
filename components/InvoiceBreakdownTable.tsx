'use client';

/**
 * InvoiceBreakdownTable — renders the per-processor / per-entity
 * breakdown attached to an invoice on the /invoicing portal page.
 * Same JSON shape as the SendGrid breakdown email; same visual logic.
 *
 * Driver: 2026-05-29 Matt — "lives in the managers portal."
 */

import { useState } from 'react';

export interface InvoiceBreakdown {
  processor_groups?: Array<{
    processor: string;
    entities: Array<{
      entity_name: string;
      form_type: string | null;
      completed_at: string | null;
      loan_number: string | null;
      unit_price: number;
      is_reorder: boolean;
    }>;
    subtotal: number;
  }>;
  monitoring_details?: Array<{
    entity_name: string;
    processor: string;
    window_start: string;
    window_end: string;
    active_days: number;
    prorated: number;
  }>;
  catchup_line?: { amount: number; memo: string } | null;
}

const fmt = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function InvoiceBreakdownTable({ breakdown, initiallyOpen = false }: { breakdown: InvoiceBreakdown; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);

  const processorGroups = breakdown.processor_groups || [];
  const monitoringDetails = breakdown.monitoring_details || [];
  const catchupLine = breakdown.catchup_line || null;

  const totalEntities = processorGroups.reduce((a, g) => a + g.entities.length, 0);
  if (totalEntities === 0 && monitoringDetails.length === 0 && !catchupLine) {
    return null;
  }

  return (
    <div className="border-t border-gray-200 bg-gray-50">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full px-6 py-3 text-left text-sm font-medium text-gray-700 hover:text-gray-900 hover:bg-gray-100 transition-colors flex items-center gap-2"
      >
        <svg
          className={`w-4 h-4 transition-transform ${open ? 'rotate-90' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <span>
          {open ? 'Hide' : 'Show'} itemized breakdown — {totalEntities} entit{totalEntities === 1 ? 'y' : 'ies'}
          {processorGroups.length > 0 && ` across ${processorGroups.length} loan officer${processorGroups.length === 1 ? '' : 's'}`}
          {monitoringDetails.length > 0 && ` · ${monitoringDetails.length} monitoring enrollment${monitoringDetails.length === 1 ? '' : 's'}`}
          {catchupLine && ' · catch-up balance'}
        </span>
      </button>

      {open && (
        <div className="px-6 pb-6 space-y-6 bg-white">
          {/* Verification by processor */}
          {processorGroups.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-mt-dark mt-4 mb-2">Tax Verification — by loan officer</h4>
              <div className="border border-gray-200 rounded-lg overflow-hidden">
                <table className="w-full">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-3 py-2 text-left text-[11px] uppercase tracking-wide text-gray-500 font-semibold">Entity</th>
                      <th className="px-3 py-2 text-left text-[11px] uppercase tracking-wide text-gray-500 font-semibold">Form</th>
                      <th className="px-3 py-2 text-left text-[11px] uppercase tracking-wide text-gray-500 font-semibold">Loan</th>
                      <th className="px-3 py-2 text-left text-[11px] uppercase tracking-wide text-gray-500 font-semibold">Completed</th>
                      <th className="px-3 py-2 text-right text-[11px] uppercase tracking-wide text-gray-500 font-semibold">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {processorGroups.map((g) => (
                      <>
                        <tr key={`hdr-${g.processor}`} className="bg-blue-50/50">
                          <td colSpan={4} className="px-3 py-2 text-xs font-bold text-blue-900">
                            {g.processor} · {g.entities.length} {g.entities.length === 1 ? 'entity' : 'entities'}
                          </td>
                          <td className="px-3 py-2 text-xs font-bold text-blue-900 text-right font-mono">
                            {fmt(g.subtotal)}
                          </td>
                        </tr>
                        {g.entities.map((e, i) => (
                          <tr key={`${g.processor}-${i}`} className="hover:bg-gray-50">
                            <td className="px-3 py-1.5 text-sm text-gray-800">
                              {e.entity_name}
                              {e.is_reorder && (
                                <span className="ml-2 inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-violet-100 text-violet-800 align-middle">REORDER</span>
                              )}
                            </td>
                            <td className="px-3 py-1.5 text-xs text-gray-600">{e.form_type || '—'}</td>
                            <td className="px-3 py-1.5 text-xs text-gray-600">{e.loan_number || '—'}</td>
                            <td className="px-3 py-1.5 text-xs text-gray-600">{e.completed_at ? e.completed_at.slice(0, 10) : '—'}</td>
                            <td className="px-3 py-1.5 text-sm text-gray-800 text-right font-mono">{fmt(e.unit_price)}</td>
                          </tr>
                        ))}
                      </>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Monitoring by enrollment */}
          {monitoringDetails.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-mt-dark mt-4 mb-2">Account Monitoring — by enrollment</h4>
              <div className="border border-gray-200 rounded-lg overflow-hidden">
                <table className="w-full">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-3 py-2 text-left text-[11px] uppercase tracking-wide text-gray-500 font-semibold">Entity</th>
                      <th className="px-3 py-2 text-left text-[11px] uppercase tracking-wide text-gray-500 font-semibold">Loan Officer</th>
                      <th className="px-3 py-2 text-left text-[11px] uppercase tracking-wide text-gray-500 font-semibold">Window</th>
                      <th className="px-3 py-2 text-right text-[11px] uppercase tracking-wide text-gray-500 font-semibold">Prorated</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {monitoringDetails.map((m, i) => (
                      <tr key={i} className="hover:bg-gray-50">
                        <td className="px-3 py-1.5 text-sm text-gray-800">{m.entity_name}</td>
                        <td className="px-3 py-1.5 text-xs text-gray-600">{m.processor}</td>
                        <td className="px-3 py-1.5 text-xs text-gray-600">
                          {m.window_start} → {m.window_end} <span className="text-gray-400">({m.active_days}/31 days)</span>
                        </td>
                        <td className="px-3 py-1.5 text-sm text-gray-800 text-right font-mono">{fmt(m.prorated)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Catch-up balance */}
          {catchupLine && (
            <div>
              <h4 className="text-sm font-semibold text-red-700 mt-4 mb-2">Catch-up balance</h4>
              <div className="border border-red-200 bg-red-50 rounded-lg p-3 flex items-start justify-between gap-4">
                <p className="text-sm text-red-900 flex-1">{catchupLine.memo}</p>
                <span className="text-sm font-mono font-bold text-red-900 whitespace-nowrap">{fmt(catchupLine.amount)}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
