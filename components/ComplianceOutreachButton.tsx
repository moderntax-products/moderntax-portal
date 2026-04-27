'use client';

/**
 * ComplianceOutreachButton — opens a modal for the manager/processor to
 * pick a template + (optional) preface message and fire the outreach
 * email to the borrower. POSTs to /api/compliance/send-template.
 *
 * The modal pre-selects the system-suggested template (highest-priority
 * flag match) but lets the sender override before send. They can also
 * add a personal preface line that gets prepended above the template
 * body — useful when there's specific context like "Quick heads-up
 * before your closing call."
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  entityId: string;
  entityName: string;
  borrowerEmail: string;
  suggestedTemplateId: string;
  allTemplates: { id: string; display_name: string }[];
}

export function ComplianceOutreachButton({
  entityId,
  entityName,
  borrowerEmail,
  suggestedTemplateId,
  allTemplates,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [templateId, setTemplateId] = useState(suggestedTemplateId);
  const [preface, setPreface] = useState('');
  const [overrideEmail, setOverrideEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSend = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const body: Record<string, string> = {
        entity_id: entityId,
        template_id: templateId,
      };
      if (preface.trim()) body.custom_message = preface.trim();
      if (overrideEmail.trim()) body.to_email = overrideEmail.trim();
      const res = await fetch('/api/compliance/send-template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to send');
        setSubmitting(false);
        return;
      }
      setSuccess(`Sent to ${data.to_email}`);
      setSubmitting(false);
      // Refresh after a moment so the funnel stats update
      setTimeout(() => {
        setOpen(false);
        setSuccess(null);
        setPreface('');
        setOverrideEmail('');
        router.refresh();
      }, 1800);
    } catch {
      setError('Network error');
      setSubmitting(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2 text-sm font-bold rounded-lg bg-mt-green text-white hover:bg-mt-green/90 shadow-sm hover:shadow transition-all"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
        </svg>
        Send template
      </button>

      {open && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => !submitting && setOpen(false)}>
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-mt-dark mb-1">Send Outreach to Borrower</h3>
            <p className="text-sm text-gray-600 mb-4">
              <span className="font-medium">{entityName}</span> · <span className="text-gray-500">{borrowerEmail}</span>
            </p>

            <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1">Template</label>
            <select
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              disabled={submitting || !!success}
              className="w-full text-sm border border-gray-300 rounded p-2 mb-4 focus:ring-2 focus:ring-mt-green/30 focus:border-mt-green"
            >
              {allTemplates.map((t) => (
                <option key={t.id} value={t.id}>{t.display_name}</option>
              ))}
            </select>

            <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1">
              Preface (optional)
            </label>
            <textarea
              value={preface}
              onChange={(e) => setPreface(e.target.value)}
              disabled={submitting || !!success}
              placeholder="Personal note that appears above the template body. e.g. 'Quick heads-up before your closing call:'"
              rows={2}
              maxLength={500}
              className="w-full text-sm border border-gray-300 rounded p-2 mb-4 focus:ring-2 focus:ring-mt-green/30 focus:border-mt-green"
            />

            <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1">
              Send to (optional override)
            </label>
            <input
              type="email"
              value={overrideEmail}
              onChange={(e) => setOverrideEmail(e.target.value)}
              disabled={submitting || !!success}
              placeholder={borrowerEmail}
              className="w-full text-sm border border-gray-300 rounded p-2 mb-4 focus:ring-2 focus:ring-mt-green/30 focus:border-mt-green"
            />
            <p className="text-[11px] text-gray-500 mb-4 -mt-3">
              Defaults to <code>{borrowerEmail}</code>. Override to send to a different contact (e.g. CPA).
            </p>

            {error && (
              <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2 mb-3">{error}</div>
            )}
            {success && (
              <div className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded p-2 mb-3">{success}</div>
            )}

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setOpen(false)}
                disabled={submitting}
                className="px-3 py-1.5 text-sm font-medium text-gray-700 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSend}
                disabled={submitting || !!success}
                className="px-3 py-1.5 text-sm font-semibold text-white bg-mt-green rounded hover:bg-mt-green/90 disabled:opacity-50"
              >
                {submitting ? 'Sending…' : success ? '✓ Sent' : 'Send Now'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
