/**
 * Token-gated preliminary-review page: /review/[token]
 *
 * The private, no-login home for a ModernTax Direct taxpayer's preliminary tax
 * review + game plan (estimates, IRS-debt path, state rules) — the same content
 * we'd otherwise put in an emailed HTML file, but gated behind a signed token
 * so the PII/estimates aren't sitting on a guessable public URL. From here the
 * taxpayer can prepay (standard or expedited) and ask questions in-thread.
 *
 * The review content is read from the entity's gross_receipts.review (authored
 * by the team). Nothing is written here.
 */

import { createAdminClient } from '@/lib/supabase-server';
import { verifyFilingIntakeToken } from '@/lib/intake-tokens';
import { DirectQuestions } from '@/components/DirectQuestions';
import { FilingPrepayCTA } from '@/components/FilingPrepayCTA';
import { PRICE_BACKYEAR_FILING, PRICE_FILING_EXPEDITE_FEE } from '@/lib/pricing';

export const dynamic = 'force-dynamic';

const C = {
  ink: '#211c17', muted: '#5e554b', line: '#e4dcd0', paper: '#faf8f3',
  accent: '#8a2433', blue: '#1f4e79',
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', background: C.paper, color: C.ink,
      fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif', lineHeight: 1.55 }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '32px 22px 64px' }}>{children}</div>
    </div>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <Shell>
      <div style={{ background: '#fff', border: `1px solid ${C.line}`, borderRadius: 12, padding: 32, textAlign: 'center' }}>
        <h1 style={{ fontSize: 20, marginBottom: 8 }}>{title}</h1>
        <p style={{ fontSize: 14, color: C.muted }}>{body}</p>
        <p style={{ fontSize: 12, color: '#999', marginTop: 16 }}>Questions? Email support@moderntax.io</p>
      </div>
    </Shell>
  );
}

type ReviewYear = { year: string; income?: number; est_balance?: number; status?: string };
type ReviewData = {
  prepared_for?: string;
  ssn_last4?: string;
  prepared_month?: string;
  intro?: string;
  status_note?: string;
  years?: ReviewYear[];
  est_total?: number;
  balance_note?: string;
  irs_plan?: string[];
  older_years_note?: string;
  states?: { nc?: { title?: string; body?: string }; sc?: { title?: string; body?: string } };
  booking_url?: string;
};

const money = (n?: number) => (typeof n === 'number' ? `$${n.toLocaleString('en-US')}` : '—');

export default async function ReviewPage({
  params, searchParams,
}: {
  params: { token: string };
  searchParams?: { paid?: string; cancel?: string };
}) {
  const entityId = verifyFilingIntakeToken(params.token);
  if (!entityId) {
    return <Notice title="This link isn’t valid" body="The link may be mistyped or expired. Please use the most recent link we emailed you." />;
  }

  const admin = createAdminClient();
  const { data: entity } = await admin.from('request_entities')
    .select('id, entity_name, gross_receipts, requests!inner(client_id, clients(credit_balance))')
    .eq('id', entityId).single() as { data: any };

  if (!entity) {
    return <Notice title="We couldn’t find your review" body="Please reach out and we’ll send you a fresh link." />;
  }

  const review: ReviewData = entity.gross_receipts?.review || {};
  const filing = entity.gross_receipts?.filing || {};
  const openYears: string[] = Array.isArray(filing.to_file_years) ? filing.to_file_years.map(String) : [];
  const yearCount = openYears.length || Number(filing.years_filed) || (review.years?.length ?? 0);

  // Prepay math (mirrors /api/public/filing-prepay) so the CTA shows real totals.
  const credit = Math.max(0, Number(entity.requests?.clients?.credit_balance) || 0);
  const base = PRICE_BACKYEAR_FILING * yearCount;
  const standardTotal = Math.max(0, base - Math.min(credit, base));
  const expeditedGross = base + PRICE_FILING_EXPEDITE_FEE;
  const expeditedTotal = Math.max(0, expeditedGross - Math.min(credit, expeditedGross));

  const bookingUrl = review.booking_url || process.env.NEXT_PUBLIC_BOOKING_URL || '';
  const alreadyPrepaid = filing.prepaid === true;
  const paidNow = searchParams?.paid === '1';

  return (
    <Shell>
      <div style={{ fontWeight: 600, letterSpacing: '.02em', color: C.accent, fontSize: 14 }}>ModernTax</div>
      <h1 style={{ fontFamily: '"Times New Roman",Georgia,serif', fontSize: 27, lineHeight: 1.2, margin: '.5em 0 .2em' }}>
        Your preliminary tax review &amp; game plan
      </h1>
      <div style={{ color: C.muted, fontSize: 15, marginBottom: 24 }}>
        {review.prepared_for ? `Prepared for ${review.prepared_for}` : entity.entity_name}
        {review.ssn_last4 ? ` · SSN ending ${review.ssn_last4}` : ''}
        {review.prepared_month ? ` · ${review.prepared_month}` : ''} · Confidential
      </div>

      {(paidNow || alreadyPrepaid) && (
        <div style={{ background: '#eef7f0', border: '1px solid #bfe0c9', borderLeft: '4px solid #2f6e4f',
          borderRadius: 8, padding: '14px 16px', margin: '18px 0', fontSize: 14.5 }}>
          <b>You’re all set.</b> Your deposit is in and your expert has been notified — they’ll reach out to confirm
          your filing status and the full quote. Use the questions box below anytime in the meantime.
        </div>
      )}

      {searchParams?.cancel === '1' && (
        <div style={{ background: '#fbf3ef', border: '1px solid #e8cfc6', borderRadius: 8, padding: '12px 16px', margin: '14px 0', fontSize: 14 }}>
          Checkout was cancelled — no charge was made. You can prepay whenever you’re ready below.
        </div>
      )}

      {review.intro && (
        <div style={{ background: '#fff', border: `1px solid ${C.line}`, borderRadius: 12, padding: '20px 22px', margin: '18px 0' }}>
          <p style={{ marginTop: 0 }}>{review.intro}</p>
        </div>
      )}

      {review.status_note && (
        <div style={{ background: '#fbf3ef', border: '1px solid #e8cfc6', borderLeft: `4px solid ${C.accent}`,
          borderRadius: 8, padding: '14px 16px', margin: '18px 0', fontSize: 14.5 }}>
          {review.status_note}
        </div>
      )}

      {review.years && review.years.length > 0 && (
        <>
          <h2 style={{ fontSize: 18, margin: '30px 0 8px' }}>The federal snapshot (preliminary, before credits)</h2>
          <table style={{ width: '100%', borderCollapse: 'collapse', margin: '6px 0', fontSize: 15 }}>
            <thead>
              <tr>
                {['Tax year', 'Income on record', 'Est. federal balance*', 'Status'].map((h, i) => (
                  <th key={h} style={{ padding: '9px 8px', textAlign: i === 0 ? 'left' : 'right', color: C.muted,
                    fontWeight: 600, fontSize: 13, borderBottom: `2px solid ${C.ink}` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {review.years.map((y) => (
                <tr key={y.year}>
                  <td style={{ padding: '9px 8px', textAlign: 'left', borderBottom: `1px solid ${C.line}` }}>{y.year}</td>
                  <td style={{ padding: '9px 8px', textAlign: 'right', borderBottom: `1px solid ${C.line}` }}>{money(y.income)}</td>
                  <td style={{ padding: '9px 8px', textAlign: 'right', borderBottom: `1px solid ${C.line}` }}>~{money(y.est_balance)}</td>
                  <td style={{ padding: '9px 8px', textAlign: 'right', borderBottom: `1px solid ${C.line}` }}>{y.status || ''}</td>
                </tr>
              ))}
            </tbody>
            {typeof review.est_total === 'number' && (
              <tfoot>
                <tr>
                  <td style={{ padding: '9px 8px', textAlign: 'left', fontWeight: 700, borderTop: `2px solid ${C.ink}` }}>Estimated total</td>
                  <td style={{ borderTop: `2px solid ${C.ink}` }} />
                  <td style={{ padding: '9px 8px', textAlign: 'right', fontWeight: 700, borderTop: `2px solid ${C.ink}` }}>~{money(review.est_total)}</td>
                  <td style={{ borderTop: `2px solid ${C.ink}` }} />
                </tr>
              </tfoot>
            )}
          </table>
          {review.balance_note && (
            <p style={{ fontSize: 13, color: C.muted }}>{review.balance_note}</p>
          )}
        </>
      )}

      {review.irs_plan && review.irs_plan.length > 0 && (
        <>
          <h2 style={{ fontSize: 18, margin: '30px 0 8px' }}>How we’ll tackle the IRS debt</h2>
          <ul style={{ margin: '8px 0', paddingLeft: 20 }}>
            {review.irs_plan.map((p, i) => (
              <li key={i} style={{ margin: '7px 0', fontSize: 15 }}>{p}</li>
            ))}
          </ul>
          {review.older_years_note && (
            <div style={{ background: '#fbf3ef', border: '1px solid #e8cfc6', borderLeft: `4px solid ${C.accent}`,
              borderRadius: 8, padding: '14px 16px', margin: '18px 0', fontSize: 14.5 }}>
              {review.older_years_note}
            </div>
          )}
        </>
      )}

      {review.states && (review.states.nc || review.states.sc) && (
        <>
          <h2 style={{ fontSize: 18, margin: '30px 0 8px' }}>Your state taxes</h2>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 10 }}>
            {[review.states.nc, review.states.sc].filter(Boolean).map((s, i) => (
              <div key={i} style={{ flex: 1, minWidth: 240, background: '#fff', border: `1px solid ${C.line}`, borderRadius: 10, padding: '14px 16px' }}>
                <h3 style={{ margin: '0 0 6px', fontSize: 15, color: C.blue }}>{s!.title}</h3>
                <p style={{ margin: 0, fontSize: 13.5, color: C.muted }}>{s!.body}</p>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Prepay */}
      {!alreadyPrepaid && yearCount > 0 && (
        <>
          <h2 style={{ fontSize: 18, margin: '30px 0 8px' }}>Get started</h2>
          <p style={{ fontSize: 15 }}>
            Ready to move? Put down a starting deposit and we’ll begin preparing your {yearCount} return{yearCount === 1 ? '' : 's'} right away.
          </p>
          <FilingPrepayCTA token={params.token} standardTotal={standardTotal} expeditedTotal={expeditedTotal} yearCount={yearCount} />
        </>
      )}

      {/* Book a call */}
      {bookingUrl && (
        <div style={{ textAlign: 'center', margin: '28px 0 8px' }}>
          <a href={bookingUrl} style={{ display: 'inline-block', background: C.accent, color: '#fff', textDecoration: 'none',
            fontWeight: 600, padding: '14px 26px', borderRadius: 10, fontSize: 16 }}>
            Book time with a ModernTax expert →
          </a>
        </div>
      )}

      {/* Questions thread */}
      <h2 style={{ fontSize: 18, margin: '34px 0 8px' }}>Questions about your estimates?</h2>
      <p style={{ fontSize: 14, color: C.muted, marginTop: 0 }}>
        Ask anything here and your ModernTax team will reply — no login needed.
      </p>
      <DirectQuestions token={params.token} />

      <div style={{ color: C.muted, fontSize: 12.5, marginTop: 36, borderTop: `1px solid ${C.line}`, paddingTop: 14 }}>
        This is a preliminary estimate and general overview based only on the third-party income records the IRS has on
        file, prepared by ModernTax under your signed authorization. It is not a filed tax return and is not personalized
        legal or tax advice — final figures, the right resolution path, and your state residency are confirmed by your
        ModernTax expert once your filing status, dependents, and any income not reported to the IRS are known. Please
        don’t act on these numbers before your review call. © 2026 ModernTax, Inc.
      </div>
    </Shell>
  );
}
