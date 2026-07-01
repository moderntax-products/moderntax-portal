/**
 * Token-gated, no-login authorization page: /authorize/[token]
 *
 * The taxpayer-facing home for signing a Form 2848 (POA) so ModernTax can fully
 * automate correcting the IRS address of record + reissuing returned ERC refund
 * checks. Renders a plain-English breakdown from the entity's
 * gross_receipts.erc_recovery (recoverable checks, why the address matters, what
 * the 2848 unlocks) plus the signature capture. Nothing is written until the
 * taxpayer signs.
 */

import { createAdminClient } from '@/lib/supabase-server';
import { verifyFilingIntakeToken } from '@/lib/intake-tokens';
import { Erc2848Authorize } from '@/components/Erc2848Authorize';

export const dynamic = 'force-dynamic';

const C = { ink: '#211c17', muted: '#5e554b', line: '#e4dcd0', paper: '#faf8f3', accent: '#8a2433', good: '#2f6e4f' };

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', background: C.paper, color: C.ink,
      fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif', lineHeight: 1.55 }}>
      <div style={{ maxWidth: 680, margin: '0 auto', padding: '32px 22px 64px' }}>{children}</div>
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

const money = (n: number) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtEin = (t: string) => (/^\d{9}$/.test(t || '') ? `${t.slice(0, 2)}-${t.slice(2)}` : t);

export default async function AuthorizePage({ params }: { params: { token: string } }) {
  const entityId = verifyFilingIntakeToken(params.token);
  if (!entityId) {
    return <Notice title="This link isn’t valid" body="The link may be mistyped or expired. Please use the most recent link we emailed you." />;
  }

  const admin = createAdminClient();
  const { data: entity } = await admin.from('request_entities')
    .select('id, entity_name, tid, gross_receipts').eq('id', entityId).single() as { data: any };
  if (!entity) return <Notice title="We couldn’t find your engagement" body="Please reach out and we’ll send you a fresh link." />;

  const erc = entity.gross_receipts?.erc_recovery || {};
  const events: any[] = Array.isArray(erc.events) ? erc.events : [];
  const recoverable = events
    .filter(e => e.status === 'undelivered' || e.status === 'returned')
    .reduce((s, e) => s + Number(e.amount || 0), 0)
    || Number(erc.total_undelivered || erc.total_recoverable || 0);
  const alreadySigned = !!erc.authorization?.signed_at;
  const mailing = erc.new_mailing_address && typeof erc.new_mailing_address === 'object' ? erc.new_mailing_address : null;

  return (
    <Shell>
      <div style={{ fontWeight: 600, letterSpacing: '.02em', color: C.accent, fontSize: 14 }}>ModernTax</div>
      <h1 style={{ fontFamily: '"Times New Roman",Georgia,serif', fontSize: 26, lineHeight: 1.2, margin: '.5em 0 .2em' }}>
        Authorize us to release your refund checks
      </h1>
      <div style={{ color: C.muted, fontSize: 15, marginBottom: 20 }}>
        {entity.entity_name} · EIN {fmtEin(entity.tid)} · Confidential
      </div>

      {/* Recoverable summary */}
      <div style={{ background: '#fff', border: `1px solid ${C.line}`, borderRadius: 12, padding: '20px 22px', margin: '16px 0' }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em', color: C.muted }}>Recoverable from the IRS</div>
        <div style={{ fontSize: 34, fontWeight: 700, color: C.good, margin: '2px 0' }}>{money(recoverable)}</div>
        <div style={{ fontSize: 13, color: C.muted }}>{events.length} refund check{events.length === 1 ? '' : 's'} confirmed intact by the IRS</div>
        {events.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12, fontSize: 14 }}>
            <thead>
              <tr>
                {['Quarter', 'Amount', 'Status'].map((h, i) => (
                  <th key={h} style={{ padding: '6px 4px', textAlign: i === 1 ? 'right' : 'left', color: C.muted, fontWeight: 600, fontSize: 12.5, borderBottom: `2px solid ${C.ink}` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {events.map((e, i) => (
                <tr key={i}>
                  <td style={{ padding: '7px 4px', borderBottom: `1px solid ${C.line}` }}>{String(e.tax_quarter || '').replace('-Q', ' Q')}</td>
                  <td style={{ padding: '7px 4px', textAlign: 'right', borderBottom: `1px solid ${C.line}` }}>{money(e.amount)}</td>
                  <td style={{ padding: '7px 4px', borderBottom: `1px solid ${C.line}`, color: C.muted }}>Returned to IRS — awaiting reissue</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Why we need the 2848 */}
      <div style={{ background: '#fff', border: `1px solid ${C.line}`, borderRadius: 12, padding: '20px 22px', margin: '16px 0' }}>
        <h2 style={{ fontSize: 17, margin: '0 0 8px' }}>Where things stand</h2>
        <p style={{ fontSize: 15, margin: '0 0 10px' }}>
          Good news first: we spoke with the IRS Business &amp; Specialty line and confirmed both of your ERC refund checks are
          <strong> intact and recoverable</strong> — they were issued in August 2022 and returned to the IRS uncashed because the
          address on file was out of date.
        </p>
        <p style={{ fontSize: 15, margin: '0 0 10px' }}>
          One step stands between you and the money: the IRS won’t reissue the checks until the <strong>address of record is
          corrected</strong>, and they’ll only let the business owner do that directly — <em>unless</em> a Power of Attorney (Form 2848)
          authorizes us to act for you.
        </p>
        <div style={{ background: '#fbf3ef', border: '1px solid #e8cfc6', borderLeft: `4px solid ${C.accent}`, borderRadius: 8, padding: '14px 16px', margin: '14px 0', fontSize: 14.5 }}>
          <strong>Signing the 2848 below lets us finish this for you.</strong> Instead of mailing a form and waiting weeks, we call
          the IRS directly, correct your address, and request both reissues on the same call. Your ERC service fee ($1,479) is
          already paid — there’s nothing more to pay here.
        </div>
      </div>

      {/* Sign */}
      {alreadySigned ? (
        <div style={{ background: '#eef7f0', border: '1px solid #bfe0c9', borderRadius: 12, padding: 24, textAlign: 'center' }}>
          <h2 style={{ margin: '0 0 8px', fontSize: 18, color: C.good }}>You’re all set ✓</h2>
          <p style={{ margin: 0, fontSize: 14.5, color: '#3c5a49' }}>
            Your Form 2848 authorization is on file. ModernTax is handling the address correction and check reissues with the
            IRS directly — nothing more is needed from you.
          </p>
        </div>
      ) : (
        <>
          <h2 style={{ fontSize: 18, margin: '26px 0 4px' }}>Sign your authorization</h2>
          <p style={{ fontSize: 14, color: C.muted, marginTop: 0 }}>Takes about a minute. No account or login required.</p>
          <Erc2848Authorize
            token={params.token}
            entityName={entity.entity_name}
            tin={fmtEin(entity.tid)}
            defaultOfficerName={erc.contact?.name || ''}
            defaultOfficerTitle={erc.contact?.title || 'CEO'}
            mailing={mailing}
          />
        </>
      )}

      <div style={{ color: C.muted, fontSize: 12.5, marginTop: 32, borderTop: `1px solid ${C.line}`, paddingTop: 14 }}>
        Form 2848 authorizes ModernTax to represent {entity.entity_name} before the IRS for the employment-tax (Employee
        Retention Credit) periods shown, limited to correcting the address of record and securing reissuance of the returned
        refund checks. It does not authorize us to endorse or deposit any check — the reissued checks are mailed directly to
        you. IRS processing times are outside ModernTax’s control. © 2026 ModernTax, Inc.
      </div>
    </Shell>
  );
}
