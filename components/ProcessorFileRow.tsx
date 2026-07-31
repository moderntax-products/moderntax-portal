'use client';

/**
 * One downloadable document in the processor's request view.
 *
 * Replaces the old single "Transcript N" link that (a) buried the individual
 * files behind a "Download all" ZIP and (b) hid the HTML copy whenever a PDF of
 * the same transcript existed. Sonja (Cal Statewide) + Elena (BFC) both work the
 * documents straight into their SBA loan file, so each format now downloads on
 * its own, and every row offers a "Copy link" — a secure, 1-hour signed URL they
 * can paste into their LOS / send to an underwriter without re-exporting.
 *
 * All three actions go through /api/download-transcript, which enforces access +
 * SOC 2 audit logging and returns a short-lived signed URL — no PII link is ever
 * long-lived or unauthenticated. Matt 2026-07-31.
 */

import { useState } from 'react';

export type FileFormat = { ext: 'PDF' | 'HTML'; path: string };

interface Props {
  label: string;
  formats: FileFormat[]; // PDF first when both exist
}

async function signedUrl(path: string): Promise<string> {
  const res = await fetch(`/api/download-transcript?path=${encodeURIComponent(path)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.url) throw new Error(data.error || 'Could not generate a secure link');
  return data.url as string;
}

export function ProcessorFileRow({ label, formats }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = async (fmt: FileFormat) => {
    setBusy(fmt.ext); setError(null);
    try {
      window.open(await signedUrl(fmt.path), '_blank');
    } catch (e: any) {
      setError(e?.message || 'Download failed');
    } finally {
      setBusy(null);
    }
  };

  const copyLink = async () => {
    // Prefer the PDF's link (what SBA systems want); fall back to whatever exists.
    const target = formats.find((f) => f.ext === 'PDF') || formats[0];
    setBusy('copy'); setError(null);
    try {
      const url = await signedUrl(target.path);
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch (e: any) {
      setError(e?.message || 'Could not copy the link');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white hover:border-gray-300 transition-colors">
      <div className="flex items-center justify-between gap-3 px-3 py-2.5">
        <div className="flex items-center gap-2.5 min-w-0">
          <svg className="w-5 h-5 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
          </svg>
          <p className="text-sm font-medium text-gray-800 truncate">{label}</p>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {formats.map((f) => {
            const primary = f.ext === 'PDF';
            return (
              <button
                key={f.ext}
                onClick={() => download(f)}
                disabled={!!busy}
                className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-semibold disabled:opacity-50 transition-colors ${
                  primary
                    ? 'bg-mt-green text-white hover:bg-opacity-90'
                    : 'border border-gray-300 text-gray-600 hover:bg-gray-50'
                }`}
              >
                {busy === f.ext ? '…' : `↓ ${f.ext}`}
              </button>
            );
          })}
          <button
            onClick={copyLink}
            disabled={!!busy}
            title="Copy a secure, 1-hour download link to paste into your loan system or send to an underwriter"
            className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-semibold border disabled:opacity-50 transition-colors ${
              copied
                ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                : 'border-gray-300 text-gray-600 hover:bg-gray-50'
            }`}
          >
            {copied ? '✓ Copied' : busy === 'copy' ? '…' : '🔗 Copy link'}
          </button>
        </div>
      </div>
      {error && <p className="px-3 pb-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}
