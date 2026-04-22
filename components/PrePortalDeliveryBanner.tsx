/**
 * Pre-portal delivery banner.
 *
 * Shown on a request/entity view when the record represents a pre-portal
 * ModernTax delivery (i.e. the IRS pull and transcript delivery happened before
 * portal.moderntax.io existed, and were imported into the portal as
 * system-of-record via the April 15, 2026 Dropbox migration).
 *
 * This exists because when a client processor opens one of these records they
 * often ask "where's the 8821?" or "why isn't ModernTax on the designee line?"
 * — the answer is that the paperwork lives in our pre-portal records, not in
 * the portal. This banner answers that in-UI so those inquiries don't keep
 * coming through email.
 *
 * Detection rules (any of):
 *  - loan_number starts with "HIST-"
 *  - request.created_at matches the Apr 15, 2026 migration window AND the
 *    request has no signed_8821_url on any entity
 * The server-side pages pass `isPrePortal` pre-computed; this component just
 * renders the banner when true.
 */
export interface PrePortalDeliveryBannerProps {
  /** True when this request is a pre-portal ModernTax delivery. */
  isPrePortal: boolean;
  /** Optional: loan number — shown in banner copy if present. */
  loanNumber?: string | null;
}

export function PrePortalDeliveryBanner({ isPrePortal, loanNumber }: PrePortalDeliveryBannerProps) {
  if (!isPrePortal) return null;

  return (
    <div className="mb-4 rounded-lg border-2 border-amber-300 bg-amber-50 p-4">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 mt-0.5">
          <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <div className="flex-1">
          <p className="text-sm font-semibold text-amber-900">
            Pre-portal ModernTax delivery
            {loanNumber ? <span className="font-normal text-amber-800"> · {loanNumber}</span> : null}
          </p>
          <p className="mt-1 text-xs text-amber-800 leading-relaxed">
            ModernTax completed the IRS pull and transcript delivery for this entity before
            portal.moderntax.io existed. The work was billed under the legacy billing process at
            that time. On April 15, 2026 the existing transcripts were migrated from Dropbox into
            the portal as system-of-record — <strong>this is not new billable work</strong>.
          </p>
          <p className="mt-1.5 text-xs text-amber-800">
            The signed 8821 for this entity is <strong>not stored in the portal</strong> — it lives
            in our pre-portal records (team Dropbox / email archive). If a client asks for the
            signed 8821 or the designee information shown on it, retrieve it from pre-portal
            records rather than the portal.
          </p>
        </div>
      </div>
    </div>
  );
}
