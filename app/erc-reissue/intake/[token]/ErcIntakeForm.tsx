'use client';

import { useState } from 'react';

interface ReissueRow {
  id: string;
  taxQuarter: string;
  originalCheckAmount: number;
  originalCheckIssuedDate: string;
}

interface Props {
  token: string;
  entityName: string;
  existingTid: string;
  reissues: ReissueRow[];
}

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
  'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC',
];

export default function ErcIntakeForm({ token, entityName, existingTid, reissues }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Form state
  const [address1, setAddress1] = useState('');
  const [address2, setAddress2] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('CA');
  const [zip, setZip] = useState('');
  const [officerName, setOfficerName] = useState('');
  const [officerTitle, setOfficerTitle] = useState('CEO');
  const [signature, setSignature] = useState('');
  const [signatureDate, setSignatureDate] = useState(new Date().toISOString().slice(0, 10));
  const [certBox, setCertBox] = useState<Record<string, 1 | 3>>(
    Object.fromEntries(reissues.map(r => [r.taxQuarter, 1 as const])),
  );
  const [consent, setConsent] = useState(false);
  const [poa2848, setPoa2848] = useState(true);
  const [notes, setNotes] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!consent) { setError('Please consent to ModernTax calling the IRS on your behalf.'); return; }
    if (signature.trim().toLowerCase() !== officerName.trim().toLowerCase()) {
      setError('Typed signature must exactly match the authorized officer name (legal requirement for the IRS).');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/erc-reissue/intake/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          new_mailing_address: { address1, address2, city, state, zip, country: 'US' },
          authorized_officer: {
            name: officerName,
            title: officerTitle,
            signature_typed: signature,
            signature_date: signatureDate,
          },
          certification_box_per_quarter: certBox,
          consent_to_call_irs: consent,
          irs_2848_poa_on_file: poa2848,
          additional_notes: notes,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Submission failed (${res.status})`);
      }
      setDone(true);
    } catch (err: any) {
      setError(err.message || 'Submission failed');
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-6 text-center">
        <h2 className="text-lg font-semibold text-emerald-900 mb-2">Intake received ✓</h2>
        <p className="text-emerald-800 text-sm mb-4">
          Thanks. Your ModernTax expert is calling the IRS Business &amp; Specialty Tax Line Monday morning at 7 AM ET to initiate the refund trace.
        </p>
        <a
          href={`/erc-reissue/${token}`}
          className="inline-block px-5 py-2 bg-emerald-600 text-white text-sm font-medium rounded hover:bg-emerald-700 transition"
        >
          View status tracker →
        </a>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* New mailing address */}
      <section className="bg-white border rounded-lg p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900 mb-1">1. Where should the IRS mail the replacement checks?</h2>
        <p className="text-sm text-gray-600 mb-4">
          The first checks were returned because the IRS address on file is outdated. Use any address you can physically check —
          business, residence, or a trusted recipient. (Returned checks aren&apos;t certified mail.)
        </p>
        <div className="grid grid-cols-1 gap-3">
          <input required value={address1} onChange={e => setAddress1(e.target.value)} placeholder="Street address" className="border rounded px-3 py-2 text-sm" />
          <input value={address2} onChange={e => setAddress2(e.target.value)} placeholder="Suite / Apt / Unit (optional)" className="border rounded px-3 py-2 text-sm" />
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <input required value={city} onChange={e => setCity(e.target.value)} placeholder="City" className="border rounded px-3 py-2 text-sm" />
            <select required value={state} onChange={e => setState(e.target.value)} className="border rounded px-3 py-2 text-sm">
              {US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <input required value={zip} onChange={e => setZip(e.target.value)} placeholder="ZIP" className="border rounded px-3 py-2 text-sm" />
          </div>
        </div>
      </section>

      {/* Certification box per quarter */}
      <section className="bg-white border rounded-lg p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900 mb-1">2. Did you physically receive these checks?</h2>
        <p className="text-sm text-gray-600 mb-4">
          For each quarter, tell us whether the check ever arrived. This determines which box we mark on Form 3911 Section III.
        </p>
        <div className="space-y-3">
          {reissues.map(r => (
            <div key={r.id} className="border rounded p-3">
              <div className="font-medium text-sm text-gray-900 mb-2">
                {r.taxQuarter} — ${r.originalCheckAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })} (issued {r.originalCheckIssuedDate})
              </div>
              <div className="space-y-1">
                <label className="flex items-start gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    checked={certBox[r.taxQuarter] === 1}
                    onChange={() => setCertBox({ ...certBox, [r.taxQuarter]: 1 })}
                    className="mt-1"
                  />
                  <span><strong>Box 1</strong> — I never received the check (most common when IRS records show &quot;returned&quot;)</span>
                </label>
                <label className="flex items-start gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    checked={certBox[r.taxQuarter] === 3}
                    onChange={() => setCertBox({ ...certBox, [r.taxQuarter]: 3 })}
                    className="mt-1"
                  />
                  <span><strong>Box 3</strong> — I received it, but it was lost, stolen, or destroyed</span>
                </label>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Authorized officer */}
      <section className="bg-white border rounded-lg p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900 mb-1">3. Authorized officer signature</h2>
        <p className="text-sm text-gray-600 mb-4">
          The IRS requires an officer of the business to sign Form 3911. Your typed signature below counts as your electronic
          signature for this filing.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
          <input required value={officerName} onChange={e => setOfficerName(e.target.value)} placeholder="Full legal name" className="border rounded px-3 py-2 text-sm" />
          <input required value={officerTitle} onChange={e => setOfficerTitle(e.target.value)} placeholder="Title (CEO, President, etc.)" className="border rounded px-3 py-2 text-sm" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <input
            required
            value={signature}
            onChange={e => setSignature(e.target.value)}
            placeholder="Type your full name to sign"
            className="border rounded px-3 py-2 text-sm font-serif italic"
          />
          <input
            required
            type="date"
            value={signatureDate}
            onChange={e => setSignatureDate(e.target.value)}
            className="border rounded px-3 py-2 text-sm"
          />
        </div>
      </section>

      {/* Consent + 2848 + notes */}
      <section className="bg-white border rounded-lg p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900 mb-1">4. Authorization &amp; consent</h2>
        <div className="space-y-3 mt-3">
          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} className="mt-1" />
            <span>
              I authorize ModernTax to contact the IRS Business &amp; Specialty Tax Line (1-800-829-4933) on behalf of <strong>{entityName}</strong> (EIN {existingTid}) to initiate the refund trace and request reissue of the returned checks.
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={poa2848} onChange={e => setPoa2848(e.target.checked)} className="mt-1" />
            <span>
              A Form 2848 Power of Attorney is on file (or I will sign one if requested) to allow ModernTax to speak to the IRS on my behalf.
            </span>
          </label>
        </div>
        <div className="mt-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">Anything else we should know? (optional)</label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} className="w-full border rounded px-3 py-2 text-sm" placeholder="e.g., contact preference, dates you're unreachable, special instructions" />
        </div>
      </section>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 text-sm p-3 rounded">{error}</div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="w-full py-3 bg-emerald-600 text-white font-medium rounded hover:bg-emerald-700 transition disabled:opacity-60"
      >
        {submitting ? 'Submitting…' : 'Submit intake — kick off the IRS trace'}
      </button>
    </form>
  );
}
