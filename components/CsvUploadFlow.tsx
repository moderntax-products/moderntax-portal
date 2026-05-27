'use client';

/**
 * CsvUploadFlow — extracted from app/new/page.tsx (CsvUploadTab) so the
 * batch-upload workflow can live at its own URL (/new/csv) for analytics
 * tracking. Identical behavior to the prior tabbed version: client-side
 * preview parsing → repeat-borrower lookup → preview table → POST to
 * /api/upload/csv → success state with loan numbers + CTA to dashboard.
 */

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase';
import * as XLSX from 'xlsx';
import { PRICE_ERC_BASE, PRICE_ERC_FULL_SWEEP_PREMIUM, PRICE_ERC_FULL_SWEEP_TOTAL, PRICE_CHECK_REISSUE, fmtUsd, fmtUsdShort } from '@/lib/pricing';

const ENTITY_TRANSCRIPT_PRICE = 19.99;
const CASH_FLOW_PACK_PRICE = 49.99;
const MONITORING_MONTHLY_PRICE = 19.99;

// Form types the dropdown offers. Order: most-common first.
// 941 (employer quarterly payroll) was added May 2026 — enables ERC
// verification workflows (TaxTaker, R&D credit shops). Requires notes
// because each ERC pull has specific per-quarter intent that the
// expert needs to understand ("confirm refund issued for Q2 2021"
// vs. "confirm claim still pending").
const FORM_TYPE_OPTIONS = ['1040', '1065', '1120', '1120S', '941', '990', '1041', 'W2_INCOME'] as const;

// Form types that benefit from the requester explaining the specific
// intent. 1040/1065/1120/1120S are the standard SBA-lender intake mix
// and don't need notes. Everything else (941 / W2 / 990 / 1041) is
// a less-common request shape where the expert needs context to
// service it correctly.
const NON_STANDARD_FORM_TYPES = new Set(['941', '990', '1041', 'W2_INCOME']);

interface CsvPreviewEntity {
  rowIndex: number;
  legalName: string;
  tid: string;
  tidKind: string;
  formType: string;
  years: string;
  email: string;
  firstName: string;
  lastName: string;
  address: string;
  city: string;
  state: string;
  zipCode: string;
  /** Add the $19.99 Entity Transcript (filing reqs / NAICS) — EIN entities only. */
  entityTranscript: boolean;
  /** Auto-generate the $49.99 SBA Cash-Flow Pack after transcripts complete. */
  cashFlowPack: boolean;
  /** Default ON — opt-out of auto monitoring enrollment for this row. */
  enrollMonitoring: boolean;
  missingFields: string[];
  isRepeat?: boolean;
  repeatOfName?: string;
  /** Set when the lookup found a prior FAILED request for this TIN+name.
   *  When true, entityTranscript is auto-checked + a banner explains why
   *  ("prior pull failed — confirming filing requirements first"). */
  priorFailed?: boolean;
  priorFailedReason?: string;
}

export function CsvUploadFlow() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [loanNumber, setLoanNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showColumnRef, setShowColumnRef] = useState(false);
  const [previewEntities, setPreviewEntities] = useState<CsvPreviewEntity[] | null>(null);
  // Per-client toggle (2026-05-27 — Centerstone flat-rate contract):
  // when client.disable_monitoring = true, hide the "Enroll Monitoring"
  // column from the preview table. Backend already strips any monitoring
  // intent from this client's invoice via the auto-invoice cron toggle,
  // but stripping it from the UI prevents processor confusion.
  const [disableMonitoring, setDisableMonitoring] = useState(false);
  const supabaseClient = useMemo(() => createClient(), []);
  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabaseClient.auth.getUser();
      if (!user) return;
      const { data: profile } = await supabaseClient
        .from('profiles')
        .select('client_id')
        .eq('id', user.id)
        .single() as { data: { client_id: string | null } | null };
      if (!profile?.client_id) return;
      const { data: client } = await supabaseClient
        .from('clients')
        .select('disable_monitoring')
        .eq('id', profile.client_id)
        .single() as { data: { disable_monitoring: boolean | null } | null };
      if (client?.disable_monitoring) setDisableMonitoring(true);
    })().catch(() => { /* silent — column missing pre-migration */ });
  }, [supabaseClient]);
  const [result, setResult] = useState<{
    requests_created: number;
    entities_created: number;
    loan_numbers: string[];
    entity_transcripts_ordered?: number;
    cash_flow_packs_ordered?: number;
    monitoring_enrollments_skipped?: number;
    // Server-side auto-corrections of form_type when explicit value mismatched
    // tid_kind (the "1040 on EIN" bug class). Surfaced as a warning banner so
    // the processor sees what we changed and can fix their CSV mapping.
    form_type_corrections?: Array<{
      row: number;
      entity_name: string;
      tid_kind: string;
      original_form: string;
      corrected_form: string;
      reason: string;
    }>;
  } | null>(null);

  const normalizeHeader = (h: string) => h.trim().toLowerCase().replace(/\s+/g, '_');

  const parseFileForPreview = useCallback(async (f: File) => {
    try {
      const buffer = await f.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);

      const entities: CsvPreviewEntity[] = rawRows.map((raw, idx) => {
        const norm: Record<string, string> = {};
        for (const [key, value] of Object.entries(raw)) {
          norm[normalizeHeader(key)] = String(value ?? '').trim();
        }
        const tidKind = norm['tid_kind'] || norm['tidkind'] || 'EIN';
        const legalName = norm['legal_name'] || norm['legalname'] || '';
        const tid = norm['tid'] || '';
        const email = norm['email'] || norm['signer_email'] || norm['signeremail'] || '';
        const firstName = norm['first_name'] || norm['firstname'] || '';
        const lastName = norm['last_name'] || norm['lastname'] || '';
        const address = norm['address'] || '';
        const city = norm['city'] || '';
        const state = norm['state'] || '';
        const zipCode = norm['zip_code'] || norm['zipcode'] || norm['zip'] || '';
        const years = norm['years'] || norm['year'] || '';

        const missing: string[] = [];
        if (!legalName) missing.push('legal_name');
        if (!tid) missing.push('tid');
        if (!email) missing.push('email');
        if (!firstName) missing.push('first name');
        if (!lastName) missing.push('last name');
        if (!address) missing.push('address');
        if (!city) missing.push('city');
        if (!state) missing.push('state');
        if (!zipCode) missing.push('zip_code');
        if (!years) missing.push('years');

        return {
          rowIndex: idx,
          legalName,
          tid,
          tidKind: ['SSN', 'ITIN'].includes(tidKind.toUpperCase()) ? 'SSN' : 'EIN',
          formType: norm['form'] || norm['form_type'] || norm['formtype'] || '1040',
          years,
          email,
          firstName,
          lastName,
          address,
          city,
          state,
          zipCode,
          entityTranscript: false,
          // Both new add-ons default OFF for cash-flow (opt-in revenue),
          // and ON for monitoring (matches the team-default-on behavior — the
          // checkbox lets the processor opt OUT for sensitive entities).
          cashFlowPack: false,
          enrollMonitoring: true,
          missingFields: missing,
        };
      });

      setPreviewEntities(entities);

      const tids = entities.map(e => e.tid).filter(Boolean);
      if (tids.length > 0) {
        try {
          const supabase = createClient();
          // Single query covers both "completed prior" and "failed prior" cases.
          // Status 'completed' → carve-out + repeat indicator + auto-attach prior data.
          // Status 'failed' → default-on Entity Transcript so we confirm filing
          // requirements before re-issuing pulls (the most common reason a
          // pull fails is wrong form_type / no return on file).
          const { data: existing } = await supabase
            .from('request_entities')
            .select('tid, entity_name, status, gross_receipts, signed_8821_url')
            .in('tid', tids)
            .in('status', ['completed', 'failed']) as { data: { tid: string; entity_name: string; status: string; gross_receipts: any; signed_8821_url: string | null }[] | null; error: unknown };

          if (existing && existing.length > 0) {
            // Build two maps: one for completed (carve-out applies) and one
            // for failed (entity transcript default-on applies). Same TIN can
            // appear in both maps if the borrower has both a completed and a
            // failed prior request — the completed match takes precedence for
            // the "repeat borrower" badge.
            const completedByTid = new Map<string, string>();
            const failedByTid = new Map<string, string>();
            for (const row of existing) {
              if (row.status === 'completed' && row.signed_8821_url) {
                completedByTid.set(row.tid, row.entity_name);
              }
              if (row.status === 'failed' && !completedByTid.has(row.tid)) {
                // Pull a useful "why it failed" hint if one was logged in
                // gross_receipts (we sometimes stash a `failure_reason` there).
                const reason = row.gross_receipts?.failure_reason || row.gross_receipts?.last_error || 'prior pull did not return transcripts';
                failedByTid.set(row.tid, typeof reason === 'string' ? reason : 'prior pull failed');
              }
            }

            const carveoutFields = new Set(['email', 'first name', 'last name', 'address', 'city', 'state', 'zip_code']);
            setPreviewEntities(prev => (prev || []).map(e => {
              const completedName = completedByTid.get(e.tid);
              const failedReason = failedByTid.get(e.tid);
              if (!completedName && !failedReason) return e;
              return {
                ...e,
                ...(completedName ? {
                  isRepeat: true,
                  repeatOfName: completedName,
                  missingFields: e.missingFields.filter(f => !carveoutFields.has(f)),
                } : {}),
                ...(failedReason ? {
                  priorFailed: true,
                  priorFailedReason: failedReason,
                  // Default-on Entity Transcript when there's a prior failed
                  // request for this TIN (regardless of tid_kind — even SSN
                  // entities benefit from the entity-transcript filing
                  // requirements lookup when the prior pull errored).
                  entityTranscript: true,
                } : {}),
              };
            }));
          }
        } catch (err) {
          console.warn('[csv-preview] repeat-borrower lookup failed:', err);
        }
      }
    } catch {
      setPreviewEntities(null);
    }
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      setFile(f);
      setError(null);
      setResult(null);
      setPreviewEntities(null);
      parseFileForPreview(f);
    }
  };

  const toggleEntityTranscript = (rowIndex: number) => {
    if (!previewEntities) return;
    setPreviewEntities(previewEntities.map(e =>
      e.rowIndex === rowIndex ? { ...e, entityTranscript: !e.entityTranscript } : e
    ));
  };

  const toggleAllEntityTranscripts = (checked: boolean) => {
    if (!previewEntities) return;
    setPreviewEntities(previewEntities.map(e =>
      e.tidKind === 'EIN' ? { ...e, entityTranscript: checked } : e
    ));
  };

  // Cash-Flow Pack toggles (mirror the entity-transcript pattern). Available
  // for any entity (individual or business) — Schedule C cash flow applies to
  // 1040 too, so we don't gate on tid_kind.
  const toggleCashFlowPack = (rowIndex: number) => {
    if (!previewEntities) return;
    setPreviewEntities(previewEntities.map(e =>
      e.rowIndex === rowIndex ? { ...e, cashFlowPack: !e.cashFlowPack } : e
    ));
  };
  const toggleAllCashFlowPacks = (checked: boolean) => {
    if (!previewEntities) return;
    setPreviewEntities(previewEntities.map(e => ({ ...e, cashFlowPack: checked })));
  };

  // Monitoring opt-out toggles — mirrors the default-on pattern. Per-row off
  // means "don't auto-enroll this entity at completion" (rare — typically
  // sensitive borrowers or one-off pulls). Default-on for everyone.
  const toggleEnrollMonitoring = (rowIndex: number) => {
    if (!previewEntities) return;
    setPreviewEntities(previewEntities.map(e =>
      e.rowIndex === rowIndex ? { ...e, enrollMonitoring: !e.enrollMonitoring } : e
    ));
  };
  const toggleAllEnrollMonitoring = (checked: boolean) => {
    if (!previewEntities) return;
    setPreviewEntities(previewEntities.map(e => ({ ...e, enrollMonitoring: checked })));
  };

  // Per-row form_type override. Most CSVs already specify the right value
  // in a `form` / `form_type` column; this dropdown lets the processor
  // fix it without re-uploading (and is the only way to flip something
  // to 941 if the CSV came from a template that didn't include it).
  const setFormType = (rowIndex: number, formType: string) => {
    if (!previewEntities) return;
    setPreviewEntities(previewEntities.map(e =>
      e.rowIndex === rowIndex ? { ...e, formType } : e
    ));
  };

  // True when ANY preview row uses a form_type that needs explanatory
  // notes. The submit button is disabled until the notes field has
  // something useful (>= 10 chars) when this is true.
  const hasNonStandardForms = previewEntities?.some(e => NON_STANDARD_FORM_TYPES.has(e.formType)) || false;
  const nonStandardRows = previewEntities?.filter(e => NON_STANDARD_FORM_TYPES.has(e.formType)) || [];
  const notesTooShort = hasNonStandardForms && notes.trim().length < 10;

  const entityTranscriptCount = previewEntities?.filter(e => e.entityTranscript).length || 0;
  const cashFlowPackCount = previewEntities?.filter(e => e.cashFlowPack).length || 0;
  const monitoringSkipCount = previewEntities?.filter(e => !e.enrollMonitoring).length || 0;
  const einCount = previewEntities?.filter(e => e.tidKind === 'EIN').length || 0;
  const hasValidationErrors = previewEntities?.some(e => e.missingFields.length > 0) || false;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) { setError('Please select a file'); return; }
    if (!loanNumber.trim()) { setError('Loan number is required'); return; }

    setIsLoading(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('loan_number', loanNumber.trim());
      if (notes) formData.append('notes', notes);

      if (previewEntities) {
        // Three add-on selection arrays — server stores them as flags on each
        // entity. Cash-flow + monitoring fire after transcript completion;
        // entity-transcript orders pull alongside the standard transcripts.
        const transcriptIndices = previewEntities.filter(e => e.entityTranscript).map(e => e.rowIndex);
        if (transcriptIndices.length > 0) {
          formData.append('entity_transcript_indices', JSON.stringify(transcriptIndices));
        }
        const cashFlowIndices = previewEntities.filter(e => e.cashFlowPack).map(e => e.rowIndex);
        if (cashFlowIndices.length > 0) {
          formData.append('cash_flow_pack_indices', JSON.stringify(cashFlowIndices));
        }
        // Inverse: rows where the processor un-checked monitoring (default ON).
        // Server uses this to skip auto-enroll for those entities at completion.
        const monitoringSkipIndices = previewEntities.filter(e => !e.enrollMonitoring).map(e => e.rowIndex);
        if (monitoringSkipIndices.length > 0) {
          formData.append('skip_monitoring_indices', JSON.stringify(monitoringSkipIndices));
        }
        // Per-row form_type overrides — only send rows where the user
        // changed the value via the dropdown vs. what was in the CSV.
        // The server uses these to override the CSV-derived form_type
        // by rowIndex.
        const formTypeOverrides = previewEntities.map(e => ({ rowIndex: e.rowIndex, formType: e.formType }));
        formData.append('form_type_overrides', JSON.stringify(formTypeOverrides));
      }

      const res = await fetch('/api/upload/csv', { method: 'POST', body: formData });
      const data = await res.json();

      if (!res.ok) {
        const detail = data.details
          ? '\n' + (Array.isArray(data.details) ? data.details.join('\n') : data.details)
          : '';
        setError(data.error + detail);
        return;
      }

      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setIsLoading(false);
    }
  };

  if (result) {
    return (
      <div className="bg-white rounded-lg shadow p-8 text-center">
        <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="text-2xl font-bold text-mt-dark mb-2">Upload Complete</h2>
        <p className="text-gray-600 mb-6">
          Created <strong>{result.requests_created}</strong> request(s) with{' '}
          <strong>{result.entities_created}</strong> total entities
          {(result.entity_transcripts_ordered || 0) > 0 && (
            <span className="block text-blue-600 mt-1">
              + {result.entity_transcripts_ordered} Entity Transcript{(result.entity_transcripts_ordered || 0) > 1 ? 's' : ''} ordered (${((result.entity_transcripts_ordered || 0) * ENTITY_TRANSCRIPT_PRICE).toFixed(2)})
            </span>
          )}
        </p>
        <div className="bg-gray-50 rounded-lg p-4 mb-6 text-left max-w-md mx-auto">
          <p className="text-sm font-semibold text-gray-700 mb-2">Loan Numbers:</p>
          <ul className="space-y-1">
            {result.loan_numbers.map((ln) => (
              <li key={ln} className="text-sm text-gray-600 font-mono">{ln}</li>
            ))}
          </ul>
        </div>

        {/* Form-type auto-correction warning — surfaces server-side fixes for the
            "1040 on EIN" bug class. The upload still succeeded; we just want the
            processor to see what we changed so they can fix their CSV mapping
            (or their LOS export) for next time. */}
        {result.form_type_corrections && result.form_type_corrections.length > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6 text-left max-w-2xl mx-auto">
            <p className="text-sm font-semibold text-amber-900 mb-2 flex items-center gap-1.5">
              <svg className="w-4 h-4 text-amber-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              Auto-corrected {result.form_type_corrections.length} form-type mismatch{result.form_type_corrections.length === 1 ? '' : 'es'}
            </p>
            <p className="text-xs text-amber-800 mb-2">
              Your CSV had form codes that didn&rsquo;t match the entity&rsquo;s tid_kind. We changed them to the correct form so the 8821s won&rsquo;t be misrouted at the IRS. Update your CSV mapping to avoid this on future uploads.
            </p>
            <ul className="text-xs text-amber-900 space-y-1 max-h-40 overflow-y-auto pr-1">
              {result.form_type_corrections.slice(0, 10).map((c, i) => (
                <li key={i} className="font-mono">
                  Row {c.row} <strong>{c.entity_name}</strong> ({c.tid_kind}):{' '}
                  <span className="line-through text-amber-700">{c.original_form}</span> →{' '}
                  <strong>{c.corrected_form}</strong>
                </li>
              ))}
              {result.form_type_corrections.length > 10 && (
                <li className="italic text-amber-700">
                  +{result.form_type_corrections.length - 10} more — see audit log for full list
                </li>
              )}
            </ul>
          </div>
        )}
        <div className="flex gap-4 justify-center">
          <button onClick={() => router.push('/')} className="bg-mt-green text-white px-6 py-3 rounded-lg font-semibold hover:bg-opacity-90 transition-colors">
            View Dashboard
          </button>
          <button
            onClick={() => {
              setResult(null);
              setFile(null);
              setLoanNumber('');
              setNotes('');
              setPreviewEntities(null);
              if (fileRef.current) fileRef.current.value = '';
            }}
            className="px-6 py-3 border border-gray-300 rounded-lg font-semibold text-gray-600 hover:bg-gray-50 transition-colors"
          >
            Upload Another
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-red-700 text-sm whitespace-pre-wrap">{error}</p>
        </div>
      )}

      <div className="bg-white rounded-lg shadow p-8">
        <h2 className="text-xl font-bold text-mt-dark mb-2">Upload CSV / Excel</h2>
        <p className="text-gray-500 text-sm mb-6">Enter the loan number and upload a spreadsheet with entity data.</p>

        <div className="mb-6">
          <label className="block text-sm font-semibold text-mt-dark mb-2">Loan Number <span className="text-red-500">*</span></label>
          <input
            type="text" value={loanNumber} onChange={(e) => setLoanNumber(e.target.value)}
            placeholder="e.g. 12345 or APP-2026-001" disabled={isLoading}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50"
          />
        </div>

        <div className="mb-6">
          <div className="flex items-center gap-3 mb-3">
            <button type="button" onClick={() => setShowColumnRef(!showColumnRef)}
              className="inline-flex items-center gap-2 text-sm font-medium text-gray-700 hover:text-gray-900 transition-colors">
              <svg className={`w-4 h-4 transition-transform ${showColumnRef ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              Column Reference
            </button>
            <button type="button"
              onClick={() => {
                const headers = 'legal_name,tid,email,years,tid_kind,form,first name,last name,address,city,state,zip_code,signature_id';
                const example = '"Acme Holdings LLC","12-3456789","owner@acme.com","2023,2024,2025","EIN","1040","Jane","Doe","123 Main St","Houston","TX","77001",""';
                const csv = headers + '\n' + example + '\n';
                const blob = new Blob([csv], { type: 'text/csv' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = 'moderntax-csv-template.csv'; a.click();
                URL.revokeObjectURL(url);
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Download Template
            </button>
          </div>

          {showColumnRef && (
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-5 space-y-4 text-sm">
              <div>
                <p className="font-semibold text-gray-900 mb-2">Required Columns:</p>
                <ul className="space-y-1.5 text-gray-700">
                  <li><span className="font-mono text-xs bg-gray-200 px-1.5 py-0.5 rounded">legal_name</span> — Legal entity name (e.g., &quot;Acme Holdings LLC&quot;)</li>
                  <li><span className="font-mono text-xs bg-gray-200 px-1.5 py-0.5 rounded">tid</span> — Tax ID number (e.g., &quot;12-3456789&quot; for EIN, &quot;123-45-6789&quot; for SSN)</li>
                  <li><span className="font-mono text-xs bg-gray-200 px-1.5 py-0.5 rounded">email</span> — Signer email for 8821 delivery (e.g., &quot;owner@acme.com&quot;)</li>
                  <li><span className="font-mono text-xs bg-gray-200 px-1.5 py-0.5 rounded">years</span> — Tax years, comma-separated (e.g., &quot;2023,2024,2025&quot;)</li>
                  <li><span className="font-mono text-xs bg-gray-200 px-1.5 py-0.5 rounded">first name</span> — Signer first name for 8821 form</li>
                  <li><span className="font-mono text-xs bg-gray-200 px-1.5 py-0.5 rounded">last name</span> — Signer last name for 8821 form</li>
                  <li><span className="font-mono text-xs bg-gray-200 px-1.5 py-0.5 rounded">address</span>, <span className="font-mono text-xs bg-gray-200 px-1.5 py-0.5 rounded">city</span>, <span className="font-mono text-xs bg-gray-200 px-1.5 py-0.5 rounded">state</span>, <span className="font-mono text-xs bg-gray-200 px-1.5 py-0.5 rounded">zip_code</span> — Entity address for 8821 form</li>
                </ul>
              </div>
              <div>
                <p className="font-semibold text-gray-900 mb-2">Optional Columns:</p>
                <ul className="space-y-1.5 text-gray-700">
                  <li><span className="font-mono text-xs bg-gray-200 px-1.5 py-0.5 rounded">tid_kind</span> — &quot;EIN&quot; (default) or &quot;SSN&quot;</li>
                  <li><span className="font-mono text-xs bg-gray-200 px-1.5 py-0.5 rounded">form</span> — Tax form: 1040, 1065, 1120, or 1120S (default: 1040)</li>
                  <li><span className="font-mono text-xs bg-gray-200 px-1.5 py-0.5 rounded">signature_id</span> — Pre-signed Dropbox Sign ID (skips 8821 send)</li>
                </ul>
              </div>
            </div>
          )}
        </div>

        <label htmlFor="csv-file-input"
          className={`block border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
            file ? 'border-mt-green bg-green-50' : 'border-gray-300 hover:border-gray-400'
          }`}>
          <input id="csv-file-input" ref={fileRef} type="file" accept=".csv,.xlsx,.xls" onChange={handleFileChange} className="hidden" />
          {file ? (
            <div>
              <svg className="w-12 h-12 text-mt-green mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <p className="text-mt-dark font-semibold">{file.name}</p>
              <p className="text-gray-500 text-sm mt-1">{(file.size / 1024).toFixed(1)} KB &middot; Click to change</p>
            </div>
          ) : (
            <div>
              <svg className="w-12 h-12 text-gray-400 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <p className="text-gray-600 font-medium">Click to select a CSV or Excel file</p>
              <p className="text-gray-400 text-sm mt-1">Supports .csv, .xlsx, .xls</p>
            </div>
          )}
        </label>

        <div className="mt-6">
          <label className="block text-sm font-semibold text-mt-dark mb-2">
            Notes{' '}
            {hasNonStandardForms ? (
              <span className="text-red-600 font-semibold">(required for {nonStandardRows.map(r => r.formType).filter((v, i, a) => a.indexOf(v) === i).join(', ')} requests)</span>
            ) : (
              <span className="text-gray-400 font-normal">(optional)</span>
            )}
          </label>
          {hasNonStandardForms && (
            <div className="mb-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded text-xs text-amber-900">
              <strong>Heads-up:</strong> {nonStandardRows.length} row{nonStandardRows.length === 1 ? '' : 's'} {nonStandardRows.length === 1 ? 'uses' : 'use'} a non-standard form type
              {nonStandardRows.some(r => r.formType === '941') && (
                <> (941 / ERC). Please describe specific quarters needed, what you&apos;re trying to confirm (e.g. refund issued? claim pending? denied?), and any context that&apos;ll help the expert work the request correctly.</>
              )}
              {!nonStandardRows.some(r => r.formType === '941') && (
                <>. Please describe the specific years / context needed for the expert.</>
              )}
            </div>
          )}
          {/* ERC pricing notice — shows when any 941 row is present so partners
              understand the tier structure before submitting. */}
          {nonStandardRows.some(r => r.formType === '941') && (
            <div className="mb-3 px-3 py-2 bg-blue-50 border border-blue-200 rounded text-xs text-blue-900">
              <p className="font-semibold mb-1">ERC analysis pricing — applies to {nonStandardRows.filter(r => r.formType === '941').length} 941 row{nonStandardRows.filter(r => r.formType === '941').length === 1 ? '' : 's'}:</p>
              <ul className="space-y-0.5 list-disc list-inside ml-1">
                <li><strong>{fmtUsd(PRICE_ERC_BASE)}</strong> per entity (base) — covers up to 3 ERC-eligible quarters + automated ERC status report</li>
                <li><strong>+ {fmtUsd(PRICE_ERC_FULL_SWEEP_PREMIUM)}</strong> premium per entity to pull ALL 6–7 eligible quarters (2020 Q2–Q4 + 2021 Q1–Q3, plus Q4 2021 for Recovery Startup Businesses) — total <strong>{fmtUsd(PRICE_ERC_FULL_SWEEP_TOTAL)}/entity</strong> for full coverage</li>
                <li><strong>{fmtUsdShort(PRICE_CHECK_REISSUE)} per check</strong> — premium recovery service if the report surfaces a refund-returned-undelivered status (we file Form 8822-B + call the IRS reissuance line on the client&apos;s behalf)</li>
              </ul>
              <p className="mt-1 text-blue-700">Mention &ldquo;full sweep&rdquo; in the Notes field below if you want the premium tier applied to these entities.</p>
            </div>
          )}
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={
              hasNonStandardForms
                ? 'e.g. "Confirm ERC refund status for Q2 2021 + Q3 2021. Check for TC 846 (refund issued) or TC 470 (claim pending). Years 2020-2024 in case of amended filings."'
                : 'Any additional context for this batch...'
            }
            rows={hasNonStandardForms ? 4 : 3}
            disabled={isLoading}
            className={`w-full px-4 py-3 border rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50 ${
              notesTooShort ? 'border-red-300 bg-red-50' : 'border-gray-300'
            }`}
          />
          {notesTooShort && (
            <p className="text-xs text-red-600 mt-1">Please add at least a sentence describing what the expert should confirm.</p>
          )}
        </div>
      </div>

      {previewEntities && previewEntities.length > 0 && (
        <div className="bg-white rounded-lg shadow p-8">
          <div className="flex items-start justify-between mb-4 flex-wrap gap-3">
            <div>
              <h3 className="text-lg font-bold text-mt-dark">Review Entities</h3>
              <p className="text-sm text-gray-500">{previewEntities.length} entities found in file</p>
            </div>
            <div className="flex items-center gap-3 text-xs flex-wrap justify-end">
              {einCount > 0 && (
                <button type="button" onClick={() => toggleAllEntityTranscripts(entityTranscriptCount < einCount)}
                  className="font-medium text-blue-600 hover:text-blue-800 transition-colors whitespace-nowrap">
                  {entityTranscriptCount >= einCount ? 'Deselect all transcripts' : `+ All ${einCount} entity transcripts`}
                </button>
              )}
              <button type="button" onClick={() => toggleAllCashFlowPacks(cashFlowPackCount < previewEntities.length)}
                className="font-medium text-indigo-600 hover:text-indigo-800 transition-colors whitespace-nowrap">
                {cashFlowPackCount >= previewEntities.length ? 'Deselect all cash-flow' : `+ All ${previewEntities.length} cash-flow packs`}
              </button>
              {!disableMonitoring && (
                <button type="button" onClick={() => toggleAllEnrollMonitoring(monitoringSkipCount > 0)}
                  className="font-medium text-emerald-600 hover:text-emerald-800 transition-colors whitespace-nowrap"
                  title="Toggle monitoring auto-enroll for all entities">
                  {monitoringSkipCount === 0 ? 'Skip monitoring for all' : 'Re-enable monitoring'}
                </button>
              )}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase">Entity Name</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase">Tax ID</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase">Signer</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase">Address</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase">Form</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase">Years</th>
                  <th className="text-center py-2 px-3 text-xs font-semibold text-blue-600 uppercase whitespace-nowrap">
                    Entity Transcript
                    <span className="block text-blue-400 font-normal normal-case">${ENTITY_TRANSCRIPT_PRICE}/ea</span>
                  </th>
                  <th className="text-center py-2 px-3 text-xs font-semibold text-indigo-600 uppercase whitespace-nowrap">
                    Cash-Flow Pack
                    <span className="block text-indigo-400 font-normal normal-case">${CASH_FLOW_PACK_PRICE}/ea</span>
                  </th>
                  {!disableMonitoring && (
                    <th className="text-center py-2 px-3 text-xs font-semibold text-emerald-600 uppercase whitespace-nowrap">
                      Monitor
                      <span className="block text-emerald-500 font-normal normal-case">${MONITORING_MONTHLY_PRICE}/mo</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {previewEntities.map((entity) => (
                  <tr key={entity.rowIndex} className={`border-b border-gray-100 hover:bg-gray-50 ${entity.missingFields.length > 0 ? 'bg-red-50' : entity.isRepeat ? 'bg-emerald-50/40' : ''}`}>
                    <td className="py-2.5 px-3 font-medium text-mt-dark">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span>{entity.legalName || <span className="text-red-500 italic">missing</span>}</span>
                        {entity.isRepeat && (
                          <span title={`Existing 8821 on file from prior request for "${entity.repeatOfName}". Signer details will be auto-filled.`}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-800 border border-emerald-200">
                            ↻ Repeat borrower
                          </span>
                        )}
                        {entity.priorFailed && (
                          <span title={`Prior pull for this TIN failed: ${entity.priorFailedReason}. Entity Transcript auto-selected to confirm filing requirements before re-pulling.`}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-800 border border-amber-200">
                            ⚠ Prior pull failed
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-2.5 px-3 font-mono text-gray-600 text-xs">
                      {entity.tid || <span className="text-red-500 italic">missing</span>}
                      <span className="text-gray-400 ml-1">({entity.tidKind})</span>
                    </td>
                    <td className="py-2.5 px-3 text-gray-600 text-xs">
                      {entity.firstName || entity.lastName ? (
                        <div>
                          <div>{entity.firstName} {entity.lastName}</div>
                          <div className="text-gray-400 truncate max-w-[160px]">{entity.email || <span className="text-red-500 italic">no email</span>}</div>
                        </div>
                      ) : entity.isRepeat ? (
                        <span className="text-emerald-700 italic text-[11px]">auto-filled from existing 8821</span>
                      ) : (
                        <span className="text-red-500 italic">missing name</span>
                      )}
                    </td>
                    <td className="py-2.5 px-3 text-gray-600 text-xs">
                      {entity.address ? (
                        <div className="max-w-[180px]">
                          <div className="truncate">{entity.address}</div>
                          <div className="text-gray-400">{entity.city}, {entity.state} {entity.zipCode}</div>
                        </div>
                      ) : entity.isRepeat ? (
                        <span className="text-emerald-700 italic text-[11px]">auto-filled</span>
                      ) : (
                        <span className="text-red-500 italic">missing</span>
                      )}
                    </td>
                    <td className="py-2.5 px-3">
                      <select
                        value={entity.formType}
                        onChange={(e) => setFormType(entity.rowIndex, e.target.value)}
                        disabled={isLoading}
                        className={`text-xs px-2 py-1 rounded border ${
                          NON_STANDARD_FORM_TYPES.has(entity.formType)
                            ? 'border-amber-300 bg-amber-50 text-amber-900 font-semibold'
                            : 'border-gray-200 bg-white text-gray-700'
                        }`}
                        title={NON_STANDARD_FORM_TYPES.has(entity.formType)
                          ? 'Non-standard form — please describe specific quarters / years / what you need confirmed in the Notes field below'
                          : ''}
                      >
                        {FORM_TYPE_OPTIONS.map(ft => (
                          <option key={ft} value={ft}>{ft === 'W2_INCOME' ? 'W&I' : ft}</option>
                        ))}
                      </select>
                    </td>
                    <td className="py-2.5 px-3 text-gray-600 text-xs">{entity.years || <span className="text-red-500 italic">missing</span>}</td>
                    <td className="py-2.5 px-3 text-center">
                      {entity.tidKind === 'EIN' ? (
                        <input type="checkbox" checked={entity.entityTranscript} onChange={() => toggleEntityTranscript(entity.rowIndex)}
                          className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                      ) : (
                        <span className="text-xs text-gray-400">N/A</span>
                      )}
                    </td>
                    <td className="py-2.5 px-3 text-center">
                      <input type="checkbox" checked={entity.cashFlowPack} onChange={() => toggleCashFlowPack(entity.rowIndex)}
                        title="Generate the SBA Cash-Flow Pack after transcripts complete"
                        className="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
                    </td>
                    {!disableMonitoring && (
                      <td className="py-2.5 px-3 text-center">
                        <input type="checkbox" checked={entity.enrollMonitoring} onChange={() => toggleEnrollMonitoring(entity.rowIndex)}
                          title="Auto-enroll in continuous monitoring after transcripts complete"
                          className="w-4 h-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500" />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {previewEntities.some(e => e.missingFields.length > 0) && (
            <div className="mt-4 rounded-lg p-3 text-sm bg-red-50 border border-red-200">
              <div className="flex items-start gap-2">
                <span className="text-lg">⚠️</span>
                <div className="flex-1">
                  <p className="text-red-800 font-semibold mb-1">Missing required fields</p>
                  <p className="text-red-700 text-xs">
                    The following fields are required to generate 8821 forms:{' '}
                    <code className="bg-red-100 px-1 rounded">legal_name</code>,{' '}
                    <code className="bg-red-100 px-1 rounded">tid</code>,{' '}
                    <code className="bg-red-100 px-1 rounded">email</code>,{' '}
                    <code className="bg-red-100 px-1 rounded">first name</code>,{' '}
                    <code className="bg-red-100 px-1 rounded">last name</code>,{' '}
                    <code className="bg-red-100 px-1 rounded">address</code>,{' '}
                    <code className="bg-red-100 px-1 rounded">city</code>,{' '}
                    <code className="bg-red-100 px-1 rounded">state</code>,{' '}
                    <code className="bg-red-100 px-1 rounded">zip_code</code>,{' '}
                    <code className="bg-red-100 px-1 rounded">years</code>.
                    Please update your spreadsheet and re-upload.
                  </p>
                  <ul className="mt-2 space-y-0.5">
                    {previewEntities.filter(e => e.missingFields.length > 0).map(e => (
                      <li key={e.rowIndex} className="text-red-700 text-xs">
                        Row {e.rowIndex + 2} ({e.legalName || 'unnamed'}): missing <strong>{e.missingFields.join(', ')}</strong>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* Add-on summary — recap each selected SKU + total before submit. */}
          {(entityTranscriptCount > 0 || cashFlowPackCount > 0 || monitoringSkipCount > 0) && (
            <div className="mt-4 rounded-lg p-3 text-sm bg-gradient-to-br from-emerald-50 to-indigo-50 border border-mt-green/30">
              <p className="font-semibold text-mt-dark mb-2">Add-ons selected</p>
              <ul className="space-y-1 text-xs text-gray-700">
                {entityTranscriptCount > 0 && (
                  <li className="flex items-center justify-between">
                    <span><strong>{entityTranscriptCount}</strong> × Entity Transcript</span>
                    <span className="font-mono text-blue-700">${(entityTranscriptCount * ENTITY_TRANSCRIPT_PRICE).toFixed(2)} one-time</span>
                  </li>
                )}
                {cashFlowPackCount > 0 && (
                  <li className="flex items-center justify-between">
                    <span><strong>{cashFlowPackCount}</strong> × Cash-Flow Pack <span className="text-gray-500">(generated after transcripts complete)</span></span>
                    <span className="font-mono text-indigo-700">${(cashFlowPackCount * CASH_FLOW_PACK_PRICE).toFixed(2)} one-time</span>
                  </li>
                )}
                <li className="flex items-center justify-between">
                  <span>
                    <strong>{previewEntities.length - monitoringSkipCount}</strong> × Monitoring auto-enroll
                    {monitoringSkipCount > 0 && <span className="text-amber-700"> ({monitoringSkipCount} opted out)</span>}
                  </span>
                  <span className="font-mono text-emerald-700">${((previewEntities.length - monitoringSkipCount) * MONITORING_MONTHLY_PRICE).toFixed(2)}/mo</span>
                </li>
              </ul>
              <p className="text-[11px] text-gray-500 mt-2 italic">
                One-time charges hit your next monthly invoice. Monitoring billing prorates from the day the entity completes.
              </p>
            </div>
          )}

          {einCount > 0 && entityTranscriptCount === 0 && cashFlowPackCount === 0 && (
            <div className="mt-4 rounded-lg p-3 text-sm bg-gray-50 border border-gray-200">
              <div className="flex items-start gap-2">
                <span className="text-lg">💡</span>
                <div className="flex-1">
                  <p className="text-gray-600">
                    <strong>Tip:</strong> Add an Entity Transcript ($19.99/ea) to confirm filing requirements before pulling income transcripts.
                    Or add a Cash-Flow Pack ($49.99/ea) to skip 30 min of underwriter Excel work after the loan is verified.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      <button type="submit" disabled={isLoading || !file || hasValidationErrors || notesTooShort}
        className="w-full bg-mt-green text-white py-4 rounded-lg font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-lg">
        {isLoading
          ? 'Processing...'
          : hasValidationErrors
          ? 'Fix Missing Fields to Continue'
          : notesTooShort
          ? 'Add Notes to Continue (941 / non-standard form selected)'
          : (
              entityTranscriptCount > 0
                ? `Upload & Create Requests (+${entityTranscriptCount} Entity Transcript${entityTranscriptCount > 1 ? 's' : ''}: $${(entityTranscriptCount * ENTITY_TRANSCRIPT_PRICE).toFixed(2)})`
                : 'Upload & Create Requests'
            )
        }
      </button>
    </form>
  );
}
