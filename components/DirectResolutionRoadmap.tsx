/**
 * ModernTax Direct — resolution roadmap (client-facing).
 *
 * Makes the path crystal-clear for a direct tax-resolution client: they must
 * file ALL outstanding federal returns before a state (NC/SC) will approve a
 * payment plan, and filing is what protects them from wage garnishment /
 * active collection. Driven by the entity's gross_receipts.resolution.
 *
 * Built 2026-06-23 (Matt: "this needs to be clear in the portal for Direct
 * clients").
 */

interface ResolutionData {
  unfiled_years?: string[];
  federal_balance?: { year?: string; amount?: number; status?: string } | null;
  states?: string[];
  current_step?: number; // 1 = filing returns, 2 = federal balance, 3 = state plan
}

const fmt = (n?: number) => (n == null ? '' : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

export function DirectResolutionRoadmap({ resolution }: { resolution: ResolutionData }) {
  const step = resolution.current_step || 1;
  const years = resolution.unfiled_years || [];
  const states = resolution.states || [];
  const fb = resolution.federal_balance || null;

  const StepDot = ({ s }: { s: number }) => {
    const state = s < step ? 'done' : s === step ? 'active' : 'pending';
    const cls = state === 'done' ? 'bg-mt-green text-white'
      : state === 'active' ? 'bg-amber-500 text-white'
      : 'bg-gray-200 text-gray-500';
    return (
      <span className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${cls}`}>
        {state === 'done' ? '✓' : s}
      </span>
    );
  };
  const tag = (s: number) => s < step
    ? <span className="text-[11px] font-semibold text-mt-green uppercase tracking-wide">Done</span>
    : s === step
      ? <span className="text-[11px] font-semibold text-amber-700 uppercase tracking-wide">In progress</span>
      : <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">Up next</span>;

  return (
    <div className="bg-white rounded-lg shadow border border-gray-200 p-8 mb-6">
      <h2 className="text-lg font-bold text-mt-dark mb-1">Your resolution roadmap</h2>
      <p className="text-sm text-gray-600 mb-5">Here's exactly what we're doing to resolve your situation and protect you from collection.</p>

      <div className="rounded-lg bg-amber-50 border border-amber-200 p-4 mb-6 flex items-start gap-3">
        <svg className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
        </svg>
        <p className="text-sm text-amber-900">
          <span className="font-semibold">Why this matters:</span> {states.length ? states.join(' and ') : 'your state(s)'} will not approve a payment
          plan until <span className="font-semibold">all of your outstanding federal returns are filed</span>. Getting these filed is what
          stops wage garnishment and active collection — so it's our first priority.
        </p>
      </div>

      <div className="space-y-5">
        <div className="flex gap-4">
          <StepDot s={1} />
          <div>
            <div className="flex items-center gap-2"><h3 className="text-sm font-semibold text-mt-dark">File your delinquent federal returns</h3>{tag(1)}</div>
            <p className="text-sm text-gray-600 mt-0.5">
              {years.length
                ? <>We're preparing your missing returns for <span className="font-medium">{years.join(', ')}</span>. We've already pulled your IRS wage records, so we only need a few details from you.</>
                : <>We're preparing your missing federal returns.</>}
            </p>
          </div>
        </div>

        <div className="flex gap-4">
          <StepDot s={2} />
          <div>
            <div className="flex items-center gap-2"><h3 className="text-sm font-semibold text-mt-dark">Resolve your federal balance</h3>{tag(2)}</div>
            <p className="text-sm text-gray-600 mt-0.5">
              {fb?.amount != null
                ? <>Your {fb.year} balance is <span className="font-medium">{fmt(fb.amount)}</span>{fb.status ? ` (currently ${fb.status})` : ''}. Once all returns are filed we'll address this with the IRS.</>
                : <>Once your returns are filed we'll address any federal balance with the IRS.</>}
            </p>
          </div>
        </div>

        <div className="flex gap-4">
          <StepDot s={3} />
          <div>
            <div className="flex items-center gap-2"><h3 className="text-sm font-semibold text-mt-dark">Set up your state payment plan{states.length > 1 ? 's' : ''}</h3>{tag(3)}</div>
            <p className="text-sm text-gray-600 mt-0.5">
              With every federal return filed, we'll establish your payment plan{states.length > 1 ? 's' : ''} with {states.length ? states.join(' and ') : 'your state'} —
              the step that takes you out of garnishment risk and into good standing.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
