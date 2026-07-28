/**
 * /direct/[token] — the ModernTax Direct taxpayer experience.
 *
 * No-login, token-gated (token = request_entities.gross_receipts.direct_token,
 * minted by /api/entity/direct-po/generate). Loads the entity's Purchase Order
 * + detected situation and hands them to <DirectExperience>, which diagnoses,
 * frames outcomes, and collects payment via the multi-line Direct PO checkout.
 *
 * Matt 2026-07-27.
 */

import { createClient } from '@supabase/supabase-js';
import { detectSituation, type DirectPurchaseOrder } from '@/lib/direct-purchase-order';
import DirectExperience from '@/components/DirectExperience';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: { token: string };
  searchParams: { paid?: string; cancel?: string };
}

function Shell({ title, body }: { title: string; body: string }) {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-6">
      <div className="bg-white p-8 rounded-xl shadow-sm border max-w-md text-center">
        <span className="text-mt-green font-black text-lg tracking-tight">ModernTax</span>
        <h1 className="text-xl font-bold text-gray-900 mt-4 mb-2">{title}</h1>
        <p className="text-gray-500">{body}</p>
      </div>
    </div>
  );
}

export default async function DirectPage({ params, searchParams }: PageProps) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { data: entity } = await supabase
    .from('request_entities')
    .select('id, entity_name, form_type, gross_receipts')
    .eq('gross_receipts->>direct_token', params.token)
    .single() as { data: any };

  if (!entity) {
    return <Shell title="Link not found" body="This link is no longer valid. Contact support@moderntax.io and we'll send you a fresh one." />;
  }

  const gr = entity.gross_receipts || {};
  const po = gr.purchase_order as DirectPurchaseOrder | undefined;

  if (!po) {
    return (
      <Shell
        title="We're preparing your plan"
        body={`Your ModernTax team is finalizing the recommended services for ${entity.entity_name}. You'll get a link as soon as it's ready.`}
      />
    );
  }

  const situation = detectSituation(gr, entity.form_type);

  return (
    <DirectExperience
      token={params.token}
      entityName={entity.entity_name}
      po={po}
      situation={situation}
      resolution={gr.resolution || null}
      ownerName={gr.owner_contact?.name || undefined}
      alreadyPaid={searchParams.paid === '1'}
    />
  );
}
