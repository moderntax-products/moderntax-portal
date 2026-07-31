'use client';

/**
 * Plain-language transcript summary for processors — renders the stored
 * gross_receipts.processor_summary (built by /api/entity/[id]/processor-summary)
 * so a loan processor gets the answer in plain English instead of opening 50
 * raw IRS HTML files. Matt 2026-07-29.
 */

import { useState, useEffect } from 'react';

type Tone = 'ok' | 'warn' | 'crit';
interface Section { title: string; body: string; tone: Tone }
interface Summary {
  headline: string;
  tone: Tone;
  sections: Section[];
  bottomLine: string;
  generatedAt: string;
}

const TONE: Record<Tone, { border: string; bg: string; text: string; dot: string }> = {
  ok: { border: 'border-emerald-200', bg: 'bg-emerald-50', text: 'text-emerald-800', dot: 'bg-emerald-500' },
  warn: { border: 'border-amber-200', bg: 'bg-amber-50', text: 'text-amber-800', dot: 'bg-amber-500' },
  crit: { border: 'border-red-200', bg: 'bg-red-50', text: 'text-red-800', dot: 'bg-red-500' },
};

export function ProcessorSummaryPanel({ entityId, initialSummary }: { entityId: string; initialSummary?: Summary | null }) {
  const [summary, setSummary] = useState<Summary | null>(initialSummary || null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/entity/${entityId}/processor-summary`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not build the summary');
      setSummary(data.summary);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  // Auto-build the summary the first time a completed request is opened without
  // one, so the processor sees the compliance picture without clicking anything.
  // It's stored on first generation, so this fires at most once per entity.
  useEffect(() => {
    if (!summary && !loading) generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!summary) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-semibold text-gray-900 text-sm">Plain-English summary</p>
            <p className="text-xs text-gray-500 mt-0.5">{loading ? 'Reading your transcripts…' : 'Skip the raw transcripts — get the compliance picture in a few lines.'}</p>
          </div>
          <button onClick={generate} disabled={loading}
            className="text-sm font-semibold text-white bg-mt-green hover:brightness-95 disabled:opacity-50 px-4 py-2 rounded-lg">
            {loading ? 'Reading transcripts…' : 'Generate summary'}
          </button>
        </div>
        {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
      </div>
    );
  }

  const head = TONE[summary.tone];
  return (
    <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
      <div className={`px-4 py-3 border-l-4 ${head.border} ${head.bg}`}>
        <div className="flex items-start gap-2">
          <span className={`mt-1.5 w-2 h-2 rounded-full ${head.dot} flex-shrink-0`} />
          <div className="flex-1">
            <p className={`font-semibold ${head.text}`}>{summary.headline}</p>
          </div>
        </div>
      </div>

      <div className="p-4 space-y-3">
        {summary.sections.map((s, i) => {
          const t = TONE[s.tone];
          return (
            <div key={i} className="flex gap-2.5">
              <span className={`mt-1.5 w-1.5 h-1.5 rounded-full ${t.dot} flex-shrink-0`} />
              <div>
                <p className="text-sm font-semibold text-gray-900">{s.title}</p>
                <p className="text-sm text-gray-600">{s.body}</p>
              </div>
            </div>
          );
        })}
      </div>

      <div className="px-4 py-3 border-t border-gray-100 bg-gray-50 flex items-start justify-between gap-3">
        <p className="text-sm text-gray-700"><span className="font-semibold">Bottom line:</span> {summary.bottomLine}</p>
        <button onClick={generate} disabled={loading}
          className="text-xs text-gray-500 hover:text-gray-700 whitespace-nowrap flex-shrink-0">
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {error && <p className="text-sm text-red-600 px-4 pb-3">{error}</p>}
    </div>
  );
}
