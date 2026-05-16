'use client';

/**
 * Admin button to regenerate an 8821 PDF with the currently-assigned
 * expert's IRS designee credentials. Visible only when there's an
 * active assignment AND the entity has a signed 8821 on file (otherwise
 * regeneration is moot — the original would be re-collected via the
 * normal intake flow).
 *
 * One click → POST /api/admin/expert/regenerate-8821 → success toast
 * with the new storage path. The original borrower-signed PDF is
 * preserved (signed_8821_url is untouched); the expert-credentialed
 * PDF is stored separately.
 */

import { useState } from 'react';

interface Props {
  entityId: string;
  entityName: string;
  expertName?: string | null;
}

export function Regenerate8821Button({ entityId, entityName, expertName }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<{ path: string; note: string } | null>(null);
  const [error, setError] = useState<{ msg: string; hint?: string } | null>(null);

  const handleClick = async () => {
    if (!confirm(`Regenerate the 8821 PDF for ${entityName} using ${expertName || 'the assigned expert'}'s IRS designee credentials?\n\nThe original borrower-signed PDF will be preserved. The new PDF will be unsigned — borrower signature still required for IRS submission.`)) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/expert/regenerate-8821', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError({ msg: data.error || 'Regeneration failed', hint: data.admin_hint });
        return;
      }
      setDone({ path: data.storage_path, note: data.note || 'Done' });
    } catch (err) {
      setError({ msg: err instanceof Error ? err.message : 'Network error' });
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded p-2 mt-1">
        ✓ Regenerated 8821 saved to <code className="font-mono">{done.path}</code>.
        <div className="text-emerald-700 mt-0.5">{done.note}</div>
      </div>
    );
  }

  return (
    <div className="mt-1">
      <button
        onClick={handleClick}
        disabled={submitting}
        className="text-xs text-blue-700 hover:text-blue-900 underline font-medium disabled:opacity-50"
        title={`Regenerate 8821 with ${expertName || 'assigned expert'}'s CAF/PTIN/phone`}
      >
        {submitting ? 'Regenerating…' : 'Regenerate 8821 w/ expert creds'}
      </button>
      {error && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2 mt-1">
          <div className="font-medium">{error.msg}</div>
          {error.hint && <div className="font-mono text-red-900 mt-0.5">{error.hint}</div>}
        </div>
      )}
    </div>
  );
}
