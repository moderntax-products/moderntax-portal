/**
 * Public, no-login filing-intake page: /intake/[token]
 *
 * A ModernTax Direct taxpayer opens this from an emailed link, fills in their
 * filing intake, and authorizes — without an account. The token authorizes
 * exactly one entity. Renders the same FilingIntakeForm the logged-in portal
 * uses, pointed at the token-gated public endpoint.
 */

import { createAdminClient } from '@/lib/supabase-server';
import { verifyFilingIntakeToken } from '@/lib/intake-tokens';
import { FilingIntakeForm } from '@/components/FilingIntakeForm';

export const dynamic = 'force-dynamic';

function maskTid(tid: string | null, kind: string | null): string {
  if (!tid) return '';
  const digits = tid.replace(/\D/g, '');
  const last4 = digits.slice(-4);
  return kind === 'EIN' ? `XX-XXX${last4}` : `XXX-XX-${last4}`;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-mt-dark text-white py-4 px-6">
        <span className="text-lg font-bold">ModernTax</span>
      </header>
      <main className="max-w-3xl mx-auto px-4 py-8">{children}</main>
    </div>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <Shell>
      <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
        <h1 className="text-xl font-bold text-mt-dark mb-2">{title}</h1>
        <p className="text-sm text-gray-600">{body}</p>
        <p className="text-xs text-gray-400 mt-4">Questions? Email support@moderntax.io</p>
      </div>
    </Shell>
  );
}

export default async function PublicIntakePage({ params }: { params: { token: string } }) {
  const entityId = verifyFilingIntakeToken(params.token);
  if (!entityId) {
    return <Notice title="This link isn't valid" body="The link may be mistyped or expired. Please use the most recent link we emailed you." />;
  }

  const admin = createAdminClient();
  const { data: entity } = await admin.from('request_entities')
    .select('id, entity_name, signer_email, tid, tid_kind, address, city, state, zip_code, gross_receipts')
    .eq('id', entityId).single() as { data: any };

  if (!entity) {
    return <Notice title="We couldn't find your intake" body="Please reach out and we'll send you a fresh link." />;
  }

  const fs = entity.gross_receipts?.filing_seed;
  if (!fs?.years?.length) {
    return <Notice title="Your intake isn't ready yet" body="We're still preparing your filing details. We'll email you the moment this form is ready to complete." />;
  }
  const fi = entity.gross_receipts?.filing_intake || {};

  return (
    <Shell>
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-mt-dark">Complete your filing intake</h1>
        <p className="text-sm text-gray-600 mt-1">A few quick details so we can prepare your returns. No account needed — your progress saves as you go.</p>
      </div>
      <FilingIntakeForm
        entityId={entity.id}
        submitUrl={`/api/public/filing-intake/${params.token}`}
        seed={{
          name: entity.entity_name,
          email: entity.signer_email || '',
          ssnMask: maskTid(entity.tid, entity.tid_kind),
          address: [entity.address, entity.city, entity.state, entity.zip_code].filter(Boolean).join(', '),
          years: fs.years,
          states: fs.states || [],
        }}
        saved={fi.answers || null}
        authorized={!!fi.authorized}
        authorizedAt={fi.authorized_at || null}
      />
    </Shell>
  );
}
