'use client';

/**
 * ModernTax Direct — taxpayer-facing filing intake + authorization.
 *
 * Renders inside the logged-in taxpayer's request page. Pre-seeded from their
 * 8821 + transcripts (passed via `seed`), it captures only the gaps needed to
 * prepare delinquent returns, then lets them AUTHORIZE filing. Answers persist
 * to the entity (gross_receipts.filing_intake) via /api/entity/filing-intake,
 * so they can return to it and so the team can prepare from it.
 *
 * Built 2026-06-23 (Matt: "hosted in the Direct taxpayer's account — login,
 * complete it, and authorize filings").
 */

import { useState } from 'react';

interface YearSeed { year: string; wages: number | null; withheld: number | null; w2s: number | null; }
interface Seed {
  name: string; email: string; ssnMask: string; address: string;
  years: YearSeed[];           // years needing filing, with the wages we pulled
  states: string[];            // e.g. ['North Carolina','South Carolina']
}
interface SavedAnswers { [k: string]: any }

interface Props {
  entityId: string;
  seed: Seed;
  saved?: SavedAnswers | null;
  authorized?: boolean;
  authorizedAt?: string | null;
}

const STATUSES = ['Single', 'Married filing jointly', 'Married filing separately', 'Head of household', 'Qualifying surviving spouse', "Didn't need to file (no/low income)"];
const usd = (n: number | null) => (n == null ? '—' : '$' + n.toLocaleString());

export function FilingIntakeForm({ entityId, seed, saved, authorized: alreadyAuthorized, authorizedAt }: Props) {
  const s0 = saved || {};
  const [dob, setDob] = useState(s0.dob || '');
  const [address, setAddress] = useState(s0.address || seed.address);
  const [statusByYear, setStatusByYear] = useState<Record<string, string>>(s0.statusByYear || {});
  const [stateByYear, setStateByYear] = useState<Record<string, string>>(s0.stateByYear || {});
  const [spouse, setSpouse] = useState(s0.spouse || { name: '', dob: '', hadIncome: false });
  const [deps, setDeps] = useState<Array<{ name: string; dob: string; rel: string; years: string; months: string }>>(s0.deps || []);
  const [noDeps, setNoDeps] = useState<boolean>(!!s0.noDeps);
  const [otherIncome, setOtherIncome] = useState(s0.otherIncome || '');
  const [selfEmp, setSelfEmp] = useState(s0.selfEmp || '');
  const [deduction, setDeduction] = useState(s0.deduction || '');
  const [ipPin, setIpPin] = useState(s0.ipPin || '');
  const [confirmIncome, setConfirmIncome] = useState<boolean>(!!s0.confirmIncome);
  const [authorize, setAuthorize] = useState(false);

  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(!!alreadyAuthorized);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const anyMarried = Object.values(statusByYear).some((v) => v.startsWith('Married'));

  const collect = () => ({ dob, address, statusByYear, stateByYear, spouse: anyMarried ? spouse : null, deps: noDeps ? [] : deps, noDeps, otherIncome, selfEmp, deduction, ipPin, confirmIncome });

  const post = async (authorizeNow: boolean) => {
    setSaving(true); setError(null); setMsg(null);
    try {
      const res = await fetch('/api/entity/filing-intake', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityId, answers: collect(), authorize: authorizeNow }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { setError(data?.error || 'Could not save.'); return; }
      if (authorizeNow) { setSubmitted(true); }
      else setMsg('Progress saved — you can finish later.');
    } catch (err: any) { setError(err?.message || 'Network error'); }
    finally { setSaving(false); }
  };

  if (submitted) {
    return (
      <div className="bg-white rounded-lg shadow border border-gray-200 p-8 mb-6">
        <div className="flex items-center gap-3">
          <span className="w-9 h-9 rounded-full bg-mt-green text-white flex items-center justify-center text-lg">✓</span>
          <div>
            <h2 className="text-lg font-bold text-mt-dark">Filing authorized — thank you</h2>
            <p className="text-sm text-gray-600">We&apos;re preparing your returns and will send each one to you to review &amp; sign before filing.{authorizedAt ? ` Authorized ${new Date(authorizedAt).toLocaleDateString()}.` : ''}</p>
          </div>
        </div>
      </div>
    );
  }

  const lbl = 'block text-xs text-gray-500 mt-3 mb-1';
  const inp = 'w-full text-sm px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-mt-green focus:border-transparent';

  return (
    <div className="bg-white rounded-lg shadow border border-gray-200 p-8 mb-6">
      <h2 className="text-lg font-bold text-mt-dark mb-1">Complete your filing intake</h2>
      <p className="text-sm text-gray-600 mb-5">We&apos;ve pre-filled what we already have from your IRS records — just confirm and fill the few gaps so we can prepare your returns. Full SSN, bank, and IP-PIN are collected separately through our secure link.</p>

      <div className="rounded-lg bg-green-50 border border-green-200 p-3 text-xs text-green-800 mb-5">From your authorization: <strong>{seed.name}</strong> · SSN {seed.ssnMask} · {seed.email}</div>

      <div className="grid sm:grid-cols-2 gap-3">
        <div><label className={lbl}>Date of birth</label><input className={inp} value={dob} onChange={(e) => setDob(e.target.value)} placeholder="MM/DD/YYYY" /></div>
        <div><label className={lbl}>Current mailing address</label><input className={inp} value={address} onChange={(e) => setAddress(e.target.value)} /></div>
      </div>

      <h3 className="text-sm font-semibold text-mt-dark mt-6 mb-1">Filing status &amp; income by year</h3>
      <p className="text-xs text-gray-500 mb-2">Wages below are already pulled from your IRS records — confirm them, then pick your status for each year.</p>
      <div className="space-y-2">
        {seed.years.map((y) => (
          <div key={y.year} className="grid grid-cols-12 gap-2 items-center text-sm">
            <div className="col-span-2 font-medium">{y.year}</div>
            <div className="col-span-4 text-gray-600">{usd(y.wages)}{y.w2s ? ` · ${y.w2s} W-2s` : ''}</div>
            <div className="col-span-6">
              <select className={inp} value={statusByYear[y.year] || ''} onChange={(e) => setStatusByYear({ ...statusByYear, [y.year]: e.target.value })}>
                <option value="">Filing status…</option>
                {STATUSES.map((st) => <option key={st}>{st}</option>)}
              </select>
            </div>
          </div>
        ))}
      </div>
      <label className="flex items-start gap-2 text-sm mt-3"><input type="checkbox" className="mt-1" checked={confirmIncome} onChange={(e) => setConfirmIncome(e.target.checked)} /><span>These W-2s are complete — or I&apos;ve noted other income below.</span></label>

      {anyMarried && (
        <div className="mt-4 border-t border-gray-200 pt-3">
          <h3 className="text-sm font-semibold text-mt-dark">Spouse (for your married year)</h3>
          <div className="grid sm:grid-cols-2 gap-3">
            <input className={inp} placeholder="Spouse legal name" value={spouse.name} onChange={(e) => setSpouse({ ...spouse, name: e.target.value })} />
            <input className={inp} placeholder="Spouse date of birth" value={spouse.dob} onChange={(e) => setSpouse({ ...spouse, dob: e.target.value })} />
          </div>
          <label className="flex items-center gap-2 text-sm mt-2"><input type="checkbox" checked={spouse.hadIncome} onChange={(e) => setSpouse({ ...spouse, hadIncome: e.target.checked })} />Spouse had income</label>
        </div>
      )}

      <h3 className="text-sm font-semibold text-mt-dark mt-6 mb-1">Dependents</h3>
      <p className="text-xs text-gray-500 mb-2">Children/relatives you supported — this can lower or refund what&apos;s owed.</p>
      {deps.map((d, i) => (
        <div key={i} className="grid grid-cols-12 gap-2 mb-2">
          <input className={`${inp} col-span-3`} placeholder="Name" value={d.name} onChange={(e) => { const n = [...deps]; n[i].name = e.target.value; setDeps(n); }} />
          <input className={`${inp} col-span-2`} placeholder="DOB" value={d.dob} onChange={(e) => { const n = [...deps]; n[i].dob = e.target.value; setDeps(n); }} />
          <input className={`${inp} col-span-3`} placeholder="Relationship" value={d.rel} onChange={(e) => { const n = [...deps]; n[i].rel = e.target.value; setDeps(n); }} />
          <input className={`${inp} col-span-2`} placeholder="Years" value={d.years} onChange={(e) => { const n = [...deps]; n[i].years = e.target.value; setDeps(n); }} />
          <button type="button" className="col-span-2 text-xs text-gray-500 border border-gray-300 rounded-lg" onClick={() => setDeps(deps.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}
      <div className="flex items-center gap-4">
        <button type="button" className="text-xs px-3 py-1.5 border border-gray-300 rounded-lg" onClick={() => { setDeps([...deps, { name: '', dob: '', rel: '', years: '', months: '' }]); setNoDeps(false); }}>+ Add dependent</button>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={noDeps} onChange={(e) => setNoDeps(e.target.checked)} />No dependents</label>
      </div>

      <h3 className="text-sm font-semibold text-mt-dark mt-6 mb-1">State residency ({seed.states.join(' &amp; ') || 'NC & SC'})</h3>
      <div className="space-y-2">
        {seed.years.map((y) => (
          <div key={y.year} className="grid grid-cols-12 gap-2 items-center text-sm">
            <div className="col-span-2 font-medium">{y.year}</div>
            <div className="col-span-10">
              <select className={inp} value={stateByYear[y.year] || ''} onChange={(e) => setStateByYear({ ...stateByYear, [y.year]: e.target.value })}>
                <option value="">Where did you live?</option>
                <option>North Carolina (full year)</option>
                <option>South Carolina (full year)</option>
                <option>NC part-year + SC part-year</option>
                <option>Other state</option>
              </select>
            </div>
          </div>
        ))}
      </div>

      <label className={lbl}>Other income the IRS may not have (cash, 1099/gig, unemployment, etc.) — describe + years</label>
      <textarea className={inp} rows={2} value={otherIncome} onChange={(e) => setOtherIncome(e.target.value)} placeholder="Leave blank if none" />
      <label className={lbl}>Were you self-employed / a business owner? Describe (business, years, rough income/expenses)</label>
      <textarea className={inp} rows={2} value={selfEmp} onChange={(e) => setSelfEmp(e.target.value)} placeholder="Leave blank if none" />
      <div className="grid sm:grid-cols-2 gap-3">
        <div><label className={lbl}>Deduction</label>
          <select className={inp} value={deduction} onChange={(e) => setDeduction(e.target.value)}>
            <option value="">Select…</option><option>Standard deduction</option><option>Itemize (mortgage/charity/medical)</option><option>Not sure — you decide</option>
          </select>
        </div>
        <div><label className={lbl}>IRS Identity Protection PIN?</label>
          <select className={inp} value={ipPin} onChange={(e) => setIpPin(e.target.value)}>
            <option value="">Select…</option><option>No</option><option>Not sure</option><option>Yes — I&apos;ll provide it securely</option>
          </select>
        </div>
      </div>

      <div className="mt-7 border-t border-gray-200 pt-5">
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" className="mt-1" checked={authorize} onChange={(e) => setAuthorize(e.target.checked)} />
          <span>I authorize ModernTax to prepare my delinquent federal returns ({seed.years.map((y) => y.year).join(', ')}) from this information and my IRS records. I understand I&apos;ll review and sign each completed return before it&apos;s filed, and that filing is a $50-per-return fee with my $100 deposit applied as credit.</span>
        </label>
        {error && <div className="mt-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">{error}</div>}
        {msg && <div className="mt-3 text-xs text-green-800 bg-green-50 border border-green-200 rounded p-2">{msg}</div>}
        <div className="mt-4 flex items-center gap-3 flex-wrap">
          <button type="button" disabled={saving || !authorize} onClick={() => post(true)} className="px-5 py-2.5 text-sm font-semibold bg-mt-green text-white rounded-lg hover:opacity-90 disabled:opacity-50">{saving ? 'Submitting…' : 'Authorize & submit'}</button>
          <button type="button" disabled={saving} onClick={() => post(false)} className="px-4 py-2.5 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50">Save progress</button>
        </div>
      </div>
    </div>
  );
}
