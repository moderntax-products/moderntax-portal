'use client';

import { useState } from 'react';

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
  'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC',
];

interface Props {
  token: string;
  entityName: string;
  tin: string;
  defaultOfficerName?: string;
  defaultOfficerTitle?: string;
  /** Address currently on file to correct to (prefill). */
  mailing?: { address1?: string; address2?: string; city?: string; state?: string; zip?: string } | null;
}

/**
 * No-login capture of the taxpayer's authorization to execute Form 2848 so
 * ModernTax can correct the IRS address of record + secure reissuance of the
 * returned ERC refund checks. Typed signature (must match the officer name) is
 * the electronic signature — same rule as the ERC-reissue intake.
 */
export function Erc2848Authorize({ token, entityName, tin, defaultOfficerName, defaultOfficerTitle, mailing }: Props) {
  const [officerName, setOfficerName] = useState(defaultOfficerName || '');
  const [officerTitle, setOfficerTitle] = useState(defaultOfficerTitle || 'CEO');
  const [signature, setSignature] = useState('');
  const [signatureDate, setSignatureDate] = useState(new Date().toISOString().slice(0, 10));
  const [address1, setAddress1] = useState(mailing?.address1 || '');
  const [address2, setAddress2] = useState(mailing?.address2 || '');
  const [city, setCity] = useState(mailing?.city || '');
  const [state, setState] = useState(mailing?.state || 'CA');
  const [zip, setZip] = useState(mailing?.zip || '');
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!consent) { setError('Please authorize ModernTax to act as your Form 2848 representative.'); return; }
    if (signature.trim().toLowerCase() !== officerName.trim().toLowerCase()) {
      setError('Your typed signature must exactly match the authorized officer’s full name (IRS requirement).');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/public/2848-authorize/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          officer: { name: officerName, title: officerTitle, signature_typed: signature, signature_date: signatureDate },
          confirmed_mailing_address: { address1, address2, city, state, zip, country: 'US' },
          consent_poa: consent,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || 'Submission failed. Please try again.'); return; }
      setDone(true);
    } catch {
      setError('Network error — please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div style={{ background: '#eef7f0', border: '1px solid #bfe0c9', borderRadius: 12, padding: 24, textAlign: 'center' }}>
        <h2 style={{ margin: '0 0 8px', fontSize: 18, color: '#2f6e4f' }}>Authorization received ✓</h2>
        <p style={{ margin: 0, fontSize: 14.5, color: '#3c5a49' }}>
          Thank you. Your signed Form 2848 authorization is on file. ModernTax will now contact the IRS directly to
          correct your address of record and request reissuance of both refund checks — you don’t need to do anything else.
          We’ll keep you posted at each step.
        </p>
      </div>
    );
  }

  const card: React.CSSProperties = { background: '#fff', border: '1px solid #e4dcd0', borderRadius: 12, padding: '20px 22px', margin: '16px 0' };
  const input: React.CSSProperties = { width: '100%', border: '1px solid #d9cfc0', borderRadius: 8, padding: '10px 12px', fontSize: 14, boxSizing: 'border-box' };
  const label: React.CSSProperties = { display: 'block', fontSize: 12.5, fontWeight: 600, color: '#5e554b', margin: '0 0 4px' };

  return (
    <form onSubmit={handleSubmit}>
      <div style={card}>
        <h2 style={{ fontSize: 16, margin: '0 0 4px' }}>1. Confirm the address for the IRS to use</h2>
        <p style={{ fontSize: 13.5, color: '#5e554b', margin: '0 0 12px' }}>
          This is the address we’ll put on record with the IRS and where both refund checks will be mailed. Use any address
          you can reliably receive mail at.
        </p>
        <div style={{ display: 'grid', gap: 10 }}>
          <div>
            <label style={label}>Street address</label>
            <input required style={input} value={address1} onChange={e => setAddress1(e.target.value)} placeholder="Street address" />
          </div>
          <div>
            <label style={label}>Suite / Apt / Unit (optional)</label>
            <input style={input} value={address2} onChange={e => setAddress2(e.target.value)} placeholder="Apt 301" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10 }}>
            <div><label style={label}>City</label><input required style={input} value={city} onChange={e => setCity(e.target.value)} /></div>
            <div><label style={label}>State</label>
              <select required style={input} value={state} onChange={e => setState(e.target.value)}>
                {US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div><label style={label}>ZIP</label><input required style={input} value={zip} onChange={e => setZip(e.target.value)} /></div>
          </div>
        </div>
      </div>

      <div style={card}>
        <h2 style={{ fontSize: 16, margin: '0 0 4px' }}>2. Authorized officer signature</h2>
        <p style={{ fontSize: 13.5, color: '#5e554b', margin: '0 0 12px' }}>
          Form 2848 must be signed by an officer of {entityName} (EIN {tin}). Your typed signature below is your electronic
          signature. <a href={`/api/public/2848/${token}`} target="_blank" rel="noopener noreferrer" style={{ color: '#8a2433', fontWeight: 600 }}>Review your Form 2848 →</a>
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
          <div><label style={label}>Full legal name</label><input required style={input} value={officerName} onChange={e => setOfficerName(e.target.value)} placeholder="Full legal name" /></div>
          <div><label style={label}>Title</label><input required style={input} value={officerTitle} onChange={e => setOfficerTitle(e.target.value)} placeholder="CEO, President, etc." /></div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div><label style={label}>Type your full name to sign</label><input required style={{ ...input, fontStyle: 'italic', fontFamily: 'Georgia, serif' }} value={signature} onChange={e => setSignature(e.target.value)} placeholder="Your full name" /></div>
          <div><label style={label}>Date</label><input required type="date" style={input} value={signatureDate} onChange={e => setSignatureDate(e.target.value)} /></div>
        </div>
      </div>

      <div style={card}>
        <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 14, cursor: 'pointer' }}>
          <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} style={{ marginTop: 3 }} />
          <span>
            I authorize <strong>ModernTax Inc</strong> to act as the Form 2848 representative for <strong>{entityName}</strong> (EIN {tin})
            before the IRS for the 941 employment-tax (Employee Retention Credit) periods, specifically to <strong>correct the
            address of record and secure reissuance of the returned refund checks</strong>. I confirm I am an officer with legal
            authority to execute this authorization.
          </span>
        </label>
      </div>

      {error && <p style={{ color: '#8a2433', fontSize: 13.5, margin: '0 0 12px' }}>{error}</p>}

      <button type="submit" disabled={submitting}
        style={{ width: '100%', padding: '14px 16px', borderRadius: 10, border: 'none', cursor: submitting ? 'default' : 'pointer', fontWeight: 600, fontSize: 16, color: '#fff', background: '#8a2433', opacity: submitting ? 0.7 : 1 }}>
        {submitting ? 'Submitting…' : 'Sign & authorize ModernTax'}
      </button>
    </form>
  );
}
