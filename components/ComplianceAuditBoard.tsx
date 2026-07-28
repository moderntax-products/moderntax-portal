'use client';

/**
 * ComplianceAuditBoard — admin surface listing every entity with an open IRS
 * compliance issue, ranked by exposure, with a per-case builder that turns a
 * flagged case into a bespoke billable-hour resolution engagement + custom
 * Stripe payment link (no fixed SKU).
 *
 * Matt 2026-07-28.
 */

import { useMemo, useState } from 'react';
import type { ComplianceCase, AuditSummary, Severity } from '@/lib/compliance-audit';

const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

interface Props {
  cases: ComplianceCase[];
  summary: AuditSummary;
  scanned: number;
  defaultRate: number;
}

const SEV_STYLE: Record<Severity, string> = {
  CRITICAL: 'bg-red-100 text-red-700',
  WARNING: 'bg-amber-100 text-amber-700',
  INFO: 'bg-gray-100 text-gray-600',
};

export default function ComplianceAuditBoard({ cases, summary, scanned, defaultRate }: Props) {
  const [q, setQ] = useState('');
  const [sev, setSev] = useState<'ALL' | Severity>('ALL');
  const [issue, setIssue] = useState('ALL');
  const [openId, setOpenId] = useState<string | null>(null);

  const issueOptions = useMemo(() => {
    const s = new Set<string>();
    cases.forEach((c) => c.issues.forEach((i) => s.add(i)));
    return Array.from(s);
  }, [cases]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return cases.filter((c) => {
      if (sev !== 'ALL' && c.severity !== sev) return false;
      if (issue !== 'ALL' && !c.issues.includes(issue)) return false;
      if (needle && !(`${c.entityName} ${c.client} ${c.tid || ''}`.toLowerCase().includes(needle))) return false;
      return true;
    });
  }, [cases, q, sev, issue]);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <div className="max-w-7xl mx-auto px-6 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold">Compliance Audit</h1>
          <p className="text-sm text-gray-500 mt-1">
            {summary.totalCases} entities with open IRS issues, swept from {scanned.toLocaleString()} on file. Turn any case
            into a billable-hour resolution engagement with a custom payment link.
          </p>
        </div>

        {/* Summary tiles */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          <Tile k="Open cases" v={String(summary.totalCases)} />
          <Tile k="Critical" v={String(summary.bySeverity.CRITICAL)} tone="crit" />
          <Tile k="Total exposure" v={usd(summary.totalExposure)} tone="crit" />
          <Tile k="With $ exposure" v={String(summary.withExposure)} />
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-2 mb-4">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search entity, client, or TIN…"
            className="flex-1 min-w-[220px] border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
          <select value={sev} onChange={(e) => setSev(e.target.value as any)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
            <option value="ALL">All severities</option>
            <option value="CRITICAL">Critical</option>
            <option value="WARNING">Warning</option>
            <option value="INFO">Info</option>
          </select>
          <select value={issue} onChange={(e) => setIssue(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
            <option value="ALL">All issues</option>
            {issueOptions.map((i) => (
              <option key={i} value={i}>{i.replace(/_/g, ' ')}</option>
            ))}
          </select>
        </div>

        {/* Table */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-gray-400 border-b border-gray-100">
                  <th className="px-4 py-2 font-medium">Severity</th>
                  <th className="px-4 py-2 font-medium">Entity</th>
                  <th className="px-4 py-2 font-medium">Client</th>
                  <th className="px-4 py-2 font-medium">Issue</th>
                  <th className="px-4 py-2 font-medium text-right">Exposure</th>
                  <th className="px-4 py-2 font-medium">Engagement</th>
                  <th className="px-4 py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <CaseRow
                    key={c.entityId}
                    c={c}
                    open={openId === c.entityId}
                    onToggle={() => setOpenId(openId === c.entityId ? null : c.entityId)}
                    defaultRate={defaultRate}
                  />
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-400">No cases match these filters.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function Tile({ k, v, tone }: { k: string; v: string; tone?: 'crit' }) {
  return (
    <div className={`rounded-xl border p-4 ${tone === 'crit' ? 'border-red-200 bg-red-50' : 'border-gray-200 bg-white'}`}>
      <p className="text-[11px] uppercase tracking-wide text-gray-500">{k}</p>
      <p className={`text-2xl font-black mt-1 ${tone === 'crit' ? 'text-red-700' : 'text-gray-900'}`}>{v}</p>
    </div>
  );
}

function CaseRow({ c, open, onToggle, defaultRate }: { c: ComplianceCase; open: boolean; onToggle: () => void; defaultRate: number }) {
  return (
    <>
      <tr className="border-b border-gray-50 hover:bg-gray-50/60">
        <td className="px-4 py-3">
          <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${SEV_STYLE[c.severity]}`}>{c.severity}</span>
        </td>
        <td className="px-4 py-3">
          <div className="font-medium text-gray-900">{c.entityName}</div>
          <div className="text-xs text-gray-400">{c.formType || '—'}{c.tid ? ` · ${c.tid}` : ''}</div>
          <div className="text-xs text-gray-500 mt-0.5 max-w-md">{c.summary}</div>
        </td>
        <td className="px-4 py-3 text-gray-600">{c.client}</td>
        <td className="px-4 py-3">
          <div className="flex flex-wrap gap-1">
            {c.issueLabels.map((l) => (
              <span key={l} className="text-[10px] bg-gray-100 text-gray-600 rounded px-1.5 py-0.5">{l}</span>
            ))}
          </div>
        </td>
        <td className="px-4 py-3 text-right tabular-nums font-semibold">{c.exposure > 0 ? usd(c.exposure) : '—'}</td>
        <td className="px-4 py-3">
          {c.engagementStatus === 'paid' ? (
            <span className="text-[10px] font-bold uppercase text-emerald-700 bg-emerald-50 rounded-full px-2 py-0.5">Paid</span>
          ) : c.engagementStatus === 'quoted' ? (
            <span className="text-[10px] font-bold uppercase text-amber-700 bg-amber-50 rounded-full px-2 py-0.5">Quoted</span>
          ) : (
            <span className="text-xs text-gray-300">—</span>
          )}
        </td>
        <td className="px-4 py-3 text-right">
          <button onClick={onToggle} className="text-mt-green font-semibold text-sm hover:underline">
            {open ? 'Close' : 'Create engagement'}
          </button>
        </td>
      </tr>
      {open && (
        <tr className="bg-gray-50/80">
          <td colSpan={7} className="px-4 py-4">
            <EngagementBuilder c={c} defaultRate={defaultRate} />
          </td>
        </tr>
      )}
    </>
  );
}

function EngagementBuilder({ c, defaultRate }: { c: ComplianceCase; defaultRate: number }) {
  const suggested =
    c.issues.includes('payroll_liability')
      ? `Payroll trust-fund resolution & TFRP defense — ${c.entityName}`
      : c.issues.includes('erc_undelivered')
        ? `ERC refund recovery (Form 3911) — ${c.entityName}`
        : c.issues.includes('unfiled_returns')
          ? `Back-year return filing & compliance — ${c.entityName}`
          : `IRS compliance resolution — ${c.entityName}`;

  const [mode, setMode] = useState<'hourly' | 'flat'>('hourly');
  const [description, setDescription] = useState(suggested);
  const [hours, setHours] = useState('');
  const [rate, setRate] = useState(String(defaultRate));
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const computed = mode === 'hourly' ? (Number(hours) || 0) * (Number(rate) || 0) : Number(amount) || 0;

  async function generate() {
    setLoading(true); setError(null); setLink(null);
    try {
      const payload: any = { entityId: c.entityId, description, notes };
      if (mode === 'hourly') { payload.hours = Number(hours); payload.rate = Number(rate); }
      else payload.amount = Number(amount);
      const res = await fetch('/api/billing/engagement-checkout', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create the payment link');
      setLink(data.url);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function copy() {
    if (!link) return;
    navigator.clipboard.writeText(link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  }

  return (
    <div className="max-w-3xl">
      <p className="text-xs text-gray-500 mb-3">
        Billable-hour engagement — no fixed SKU. Set the scope and price for <strong>{c.entityName}</strong>, then send the
        client the payment link.
      </p>
      <label className="block text-xs font-medium text-gray-600 mb-1">Engagement description</label>
      <input value={description} onChange={(e) => setDescription(e.target.value)}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3" />

      <div className="flex gap-2 mb-3">
        <button onClick={() => setMode('hourly')} className={`text-xs font-semibold px-3 py-1.5 rounded-lg border ${mode === 'hourly' ? 'border-mt-green text-mt-green bg-mt-green/5' : 'border-gray-300 text-gray-500'}`}>Hours × rate</button>
        <button onClick={() => setMode('flat')} className={`text-xs font-semibold px-3 py-1.5 rounded-lg border ${mode === 'flat' ? 'border-mt-green text-mt-green bg-mt-green/5' : 'border-gray-300 text-gray-500'}`}>Flat amount</button>
      </div>

      {mode === 'hourly' ? (
        <div className="flex gap-3 items-end mb-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Estimated hours</label>
            <input value={hours} onChange={(e) => setHours(e.target.value)} type="number" min="0" step="0.5"
              className="w-28 border border-gray-300 rounded-lg px-3 py-2 text-sm" placeholder="0" />
          </div>
          <span className="pb-2 text-gray-400">×</span>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Rate ($/hr)</label>
            <input value={rate} onChange={(e) => setRate(e.target.value)} type="number" min="0" step="25"
              className="w-28 border border-gray-300 rounded-lg px-3 py-2 text-sm" />
          </div>
        </div>
      ) : (
        <div className="mb-3">
          <label className="block text-xs font-medium text-gray-600 mb-1">Flat engagement fee ($)</label>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} type="number" min="0" step="100"
            className="w-40 border border-gray-300 rounded-lg px-3 py-2 text-sm" placeholder="0" />
        </div>
      )}

      <div className="mb-3">
        <label className="block text-xs font-medium text-gray-600 mb-1">Internal notes (optional)</label>
        <input value={notes} onChange={(e) => setNotes(e.target.value)}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" placeholder="Scope, assumptions, who owns it…" />
      </div>

      <div className="flex items-center gap-3">
        <button onClick={generate} disabled={loading || computed <= 0}
          className="bg-mt-green hover:brightness-95 disabled:opacity-50 text-white font-bold px-6 py-2.5 rounded-lg text-sm transition">
          {loading ? 'Creating link…' : `Generate payment link — ${usd(computed)}`}
        </button>
        {c.hasDirectPO && c.directToken && (
          <a href={`/direct/${c.directToken}`} target="_blank" rel="noreferrer" className="text-sm text-gray-500 hover:underline">
            Open Direct page →
          </a>
        )}
      </div>

      {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
      {link && (
        <div className="mt-3 flex items-center gap-2 bg-white border border-gray-200 rounded-lg px-3 py-2">
          <input readOnly value={link} className="flex-1 text-sm text-gray-600 bg-transparent outline-none" />
          <button onClick={copy} className="text-mt-green font-semibold text-sm">{copied ? 'Copied!' : 'Copy'}</button>
        </div>
      )}
    </div>
  );
}
