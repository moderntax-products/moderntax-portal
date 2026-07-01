/**
 * Token-gated, no-login self-service page: /authorize/[token]
 *
 * Helps a ModernTax Direct taxpayer release ERC refund checks that the IRS
 * returned undelivered. Per the IRS Business & Specialty line (Mento call,
 * 2026-06-09): the checks are recoverable but the IRS will ONLY reissue after
 * the address of record is corrected, and that correction can only be made by
 * the taxpayer calling in OR by a mailed Form 8822-B — a 2848/POA cannot do it.
 * So this page gives the taxpayer the fastest path (a 2-minute call with an
 * exact script) plus the 8822-B mail backup we've already sent.
 *
 * Reads gross_receipts.erc_recovery. Nothing is written until the taxpayer
 * confirms they made the call.
 */

import { createAdminClient } from '@/lib/supabase-server';
import { verifyFilingIntakeToken } from '@/lib/intake-tokens';
import { ErcReleaseActions } from '@/components/ErcReleaseActions';

export const dynamic = 'force-dynamic';

const IRS_BUSINESS_LINE = '800-829-4933';
const C = { ink: '#211c17', muted: '#5e554b', line: '#e4dcd0', paper: '#faf8f3', accent: '#8a2433', good: '#2f6e4f', blue: '#1f4e79' };

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

function formatAddr(addr: any): string {
  if (!addr) return '';
  if (typeof addr === 'string') return addr;
  const line1 = [addr.address1, addr.address2].filter(Boolean).join(', ');
  const csz = [[addr.city, addr.state].filter(Boolean).join(', '), addr.zip].filter(Boolean).join(' ').trim();
  return [line1, csz].filter(Boolean).join(', ');
}

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

  const ein = fmtEin(entity.tid);
  const newAddr = formatAddr(erc.new_mailing_address);
  const oldAddr = formatAddr(erc.old_address_of_record);
  const officer = erc.responsible_party?.name || erc.contact?.name || 'the responsible party';
  const alreadyConfirmed = !!erc.call_confirmed_at;

  // Exact quarters + amounts for the script.
  const checkList = events
    .map(e => `${String(e.tax_quarter || '').replace('-Q', ' Q')} for ${money(e.amount)}`)
    .join(' and ');

  const script =
    `Hi, I'm ${officer}, the responsible party for ${entity.entity_name}, EIN ${ein}. ` +
    (oldAddr ? `I need to update my business address of record from ${oldAddr} to ${newAddr}. ` : `I need to update my business address of record to ${newAddr}. `) +
    `I'm also requesting reissuance of ${events.length === 1 ? 'a returned Form 941 refund check' : `${events.length} returned Form 941 refund checks`} — ` +
    `${checkList} — that were returned to the IRS undelivered in 2022.`;

  return (
    <Shell>
      <div style={{ fontWeight: 600, letterSpacing: '.02em', color: C.accent, fontSize: 14 }}>ModernTax</div>
      <h1 style={{ fontFamily: '"Times New Roman",Georgia,serif', fontSize: 26, lineHeight: 1.2, margin: '.5em 0 .2em' }}>
        Release your {money(recoverable)} in IRS refunds
      </h1>
      <div style={{ color: C.muted, fontSize: 15, marginBottom: 20 }}>
        {entity.entity_name} · EIN {ein} · Confidential
      </div>

      {/* Recoverable summary */}
      <div style={{ background: '#fff', border: `1px solid ${C.line}`, borderRadius: 12, padding: '20px 22px', margin: '16px 0' }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em', color: C.muted }}>Confirmed recoverable from the IRS</div>
        <div style={{ fontSize: 34, fontWeight: 700, color: C.good, margin: '2px 0' }}>{money(recoverable)}</div>
        {events.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12, fontSize: 14 }}>
            <thead>
              <tr>
                {['Quarter (Form 941)', 'Amount', 'Status'].map((h, i) => (
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

      {/* The one step left */}
      <div style={{ background: '#fff', border: `1px solid ${C.line}`, borderRadius: 12, padding: '20px 22px', margin: '16px 0' }}>
        <h2 style={{ fontSize: 17, margin: '0 0 8px' }}>You’re one step away</h2>
        <p style={{ fontSize: 15, margin: '0 0 10px' }}>
          We spoke with the IRS and confirmed both refund checks are intact and recoverable — they were issued in August 2022 and
          returned uncashed because the address on file is out of date. The IRS will reissue them as soon as your
          <strong> address of record is corrected</strong>{oldAddr ? <> (from <strong>{oldAddr}</strong> to <strong>{newAddr}</strong>)</> : null}.
        </p>
        <p style={{ fontSize: 15, margin: 0 }}>
          The IRS only accepts that correction two ways — directly from you, or by a mailed form. Your ERC service fee ($1,479) is
          already paid; there’s nothing more to pay.
        </p>
      </div>

      {alreadyConfirmed ? (
        <div style={{ background: '#eef7f0', border: '1px solid #bfe0c9', borderRadius: 12, padding: 24, textAlign: 'center', margin: '16px 0' }}>
          <h2 style={{ margin: '0 0 8px', fontSize: 18, color: C.good }}>Thanks — noted ✓</h2>
          <p style={{ margin: 0, fontSize: 14.5, color: '#3c5a49' }}>
            You’ve told us you called the IRS to correct the address and request reissue. Address updates typically post within
            ~4–6 weeks, then both checks are mailed to your new address. We’ll keep watching your account and follow up.
          </p>
        </div>
      ) : (
        <>
          {/* Option A — call */}
          <div style={{ background: '#fff', border: `2px solid ${C.accent}`, borderRadius: 12, padding: '20px 22px', margin: '16px 0' }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: C.accent }}>Fastest · about 2 minutes</div>
            <h2 style={{ fontSize: 18, margin: '4px 0 8px' }}>Call the IRS and read this</h2>
            <p style={{ fontSize: 15, margin: '0 0 10px' }}>
              Call the IRS Business &amp; Specialty line and give them the script below. Have your EIN handy; they’ll verify you’re
              the responsible party.
            </p>
            <a href={`tel:+1${IRS_BUSINESS_LINE.replace(/\D/g, '')}`}
              style={{ display: 'inline-block', background: C.accent, color: '#fff', textDecoration: 'none', fontWeight: 700, fontSize: 20, padding: '10px 20px', borderRadius: 10, letterSpacing: '.02em' }}>
              📞 {IRS_BUSINESS_LINE}
            </a>
            <div style={{ fontSize: 12.5, color: C.muted, margin: '6px 0 12px' }}>Mon–Fri, 7:00 a.m.–7:00 p.m. local time</div>
            <div style={{ fontSize: 12.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em', color: C.muted, marginBottom: 6 }}>What to say</div>
            <blockquote style={{ margin: 0, background: '#faf8f3', border: `1px solid ${C.line}`, borderLeft: `4px solid ${C.accent}`, borderRadius: 8, padding: '14px 16px', fontSize: 15, fontStyle: 'italic', color: C.ink }}>
              “{script}”
            </blockquote>
            <div style={{ marginTop: 16 }}>
              <ErcReleaseActions token={params.token} />
            </div>
          </div>

          {/* Option B — 8822-B */}
          <div style={{ background: '#fff', border: `1px solid ${C.line}`, borderRadius: 12, padding: '18px 22px', margin: '16px 0' }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: C.blue }}>Or — no action needed</div>
            <h2 style={{ fontSize: 17, margin: '4px 0 6px' }}>Sit tight, we’ve mailed your form</h2>
            <p style={{ fontSize: 14.5, margin: 0, color: C.muted }}>
              You already signed a Form 8822-B (address change), and we’ve mailed it to the IRS on your behalf. Mailed changes
              typically post within ~4–6 weeks, and then both checks are reissued to your new address automatically. Calling is
              simply the faster route — either way, you’re covered.
            </p>
          </div>
        </>
      )}

      <div style={{ color: C.muted, fontSize: 12.5, marginTop: 28, borderTop: `1px solid ${C.line}`, paddingTop: 14 }}>
        Refund amounts and timing are confirmed by the IRS, not ModernTax, and IRS processing times are outside our control. The
        reissued checks are mailed directly to you; ModernTax never receives, endorses, or deposits them. © 2026 ModernTax, Inc.
      </div>
    </Shell>
  );
}
