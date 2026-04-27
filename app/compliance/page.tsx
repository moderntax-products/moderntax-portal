/**
 * Manager + Processor Compliance Page
 *
 * Surfaces flagged entities for the user's client (admins see all).
 * Each flagged entity gets a "Send template" action that fires a
 * borrower-direct outreach email with embedded Calendly link to book a
 * resolution call with the ModernTax team.
 *
 * Robert/Enterprise Bank Apr 27 ask: "We're trying to tell them exactly
 * how to resolve it because we need the issue resolved." This page is
 * the first surfacing of compliance flags outside the admin role.
 *
 * UI design notes:
 *   - "How this works" callout always visible at top — onboarding for
 *     teams like Enterprise Bank where 70 people will see this page.
 *   - Critical findings get their own section above warnings, so a
 *     processor scanning the page knows what's urgent without parsing
 *     a single big list.
 *   - Each row reads like a sentence: borrower → loan → issue → action.
 *   - Send Template button is the visual anchor — large, green, obvious.
 *   - Empty state explains the value proposition (this is the page
 *     where compliance opportunities turn into resolved loans).
 */

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createServerComponentClient } from '@/lib/supabase-server';
import { ComplianceOutreachButton } from '@/components/ComplianceOutreachButton';
import { TEMPLATES, suggestTemplate } from '@/lib/compliance-templates';

// Plain-English label + icon for each flag type. Keeps the chips
// scannable at a glance instead of forcing the processor to remember
// what "CIVPEN" means.
const FLAG_LABEL: Record<string, { label: string; icon: string; color: 'red' | 'amber' }> = {
  BALANCE_DUE: { label: 'Balance owed', icon: '💸', color: 'red' },
  LIEN: { label: 'Federal lien', icon: '🔒', color: 'red' },
  LEVY: { label: 'Active levy', icon: '⚡', color: 'red' },
  COLLECTION: { label: 'In collections', icon: '📞', color: 'red' },
  UNFILED: { label: 'Unfiled return', icon: '📭', color: 'red' },
  SFR: { label: 'Substitute return', icon: '🔄', color: 'red' },
  AUDIT: { label: 'Under audit', icon: '🔍', color: 'amber' },
  CIVPEN: { label: 'Civil penalty', icon: '⚠️', color: 'red' },
  LATE_FILING_PENALTY: { label: 'Late filing penalty', icon: '⏰', color: 'amber' },
  NO_RECORD: { label: 'No IRS record', icon: '❓', color: 'amber' },
};

function flagDisplay(type: string) {
  return FLAG_LABEL[type] || { label: type.replace(/_/g, ' ').toLowerCase(), icon: '⚠️', color: 'amber' as const };
}

export default async function CompliancePage() {
  const supabase = await createServerComponentClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, client_id')
    .eq('id', user.id)
    .single() as { data: { role: string; client_id: string | null } | null; error: any };
  if (!profile) redirect('/');
  if (!['admin', 'manager', 'processor'].includes(profile.role)) redirect('/');

  // Pull flagged entities scoped to the user's client (admins get all).
  let entityQuery = supabase
    .from('request_entities')
    .select(
      'id, entity_name, gross_receipts, signer_email, signer_first_name, signer_last_name, completed_at, ' +
      'requests(id, loan_number, client_id, requested_by, clients(name), profiles!requests_requested_by_fkey(full_name, email))'
    )
    .eq('status', 'completed')
    .not('gross_receipts', 'is', null);
  if (profile.role !== 'admin' && profile.client_id) {
    // Filter via the join — Supabase syntax for nested filter
    entityQuery = entityQuery.eq('requests.client_id', profile.client_id);
  }
  const { data: rawEntities } = await entityQuery as { data: any[] | null; error: any };

  // Reduce to entities with at least one CRITICAL or WARNING flag.
  const entities = (rawEntities || [])
    .filter(e => e.requests) // RLS join filter applied above
    .map((e: any) => {
      const allFlags: { type: string; message: string; severity: string }[] = [];
      let totalExposure = 0;
      for (const v of Object.values(e.gross_receipts || {})) {
        if (v && typeof v === 'object') {
          if (Array.isArray((v as any).flags)) allFlags.push(...(v as any).flags);
          if ((v as any).financials) {
            totalExposure += ((v as any).financials.accountBalance || 0)
              + ((v as any).financials.accruedInterest || 0)
              + ((v as any).financials.accruedPenalty || 0);
          }
        }
      }
      const flagTypes = [...new Set(allFlags.map(f => f.type))];
      const hasCritical = allFlags.some(f => f.severity === 'CRITICAL');
      const suggested = suggestTemplate(allFlags);
      return {
        id: e.id,
        entity_name: e.entity_name,
        signer_email: e.signer_email,
        signer_first_name: e.signer_first_name,
        signer_last_name: e.signer_last_name,
        loan_number: e.requests?.loan_number,
        request_id: e.requests?.id,
        completed_at: e.completed_at,
        all_flags: allFlags,
        flag_types: flagTypes,
        flag_count: allFlags.length,
        has_critical: hasCritical,
        total_exposure: totalExposure,
        suggested_template_id: suggested?.id || null,
        suggested_template_name: suggested?.display_name || null,
        suggested_template_short: suggested?.short_description || null,
      };
    })
    .filter(e => e.flag_count > 0)
    .sort((a, b) => (b.has_critical === a.has_critical ? b.flag_count - a.flag_count : (a.has_critical ? -1 : 1)));

  const criticalEntities = entities.filter(e => e.has_critical);
  const warningEntities = entities.filter(e => !e.has_critical);
  const totalCritical = criticalEntities.length;
  const totalExposure = entities.reduce((sum, e) => sum + (e.total_exposure || 0), 0);
  const fmtMoney = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-mt-dark">Compliance Opportunities</h1>
            <p className="text-gray-600 text-sm mt-1">
              Borrowers with IRS findings that need resolution before closing. Send a guided outreach to start the conversation.
            </p>
          </div>
          <Link href="/" className="text-sm text-gray-600 hover:text-gray-900 font-medium whitespace-nowrap">&larr; Back to Dashboard</Link>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">

        {/* HOW THIS WORKS — always visible. New users to the page need
            to grok the value prop in 5 seconds: borrower has IRS issue
            → you send template → borrower books call → we resolve. */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5 mb-6">
          <h2 className="text-sm font-bold text-mt-dark mb-3 flex items-center gap-2">
            <svg className="w-4 h-4 text-mt-green" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z" />
            </svg>
            How this works
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
            <div className="flex gap-3">
              <span className="shrink-0 w-7 h-7 rounded-full bg-mt-green text-white font-bold text-xs flex items-center justify-center">1</span>
              <div>
                <p className="font-semibold text-mt-dark">Pick a borrower with findings</p>
                <p className="text-xs text-gray-600 mt-0.5">We surface every entity flagged with a balance due, lien, unfiled return, audit, or civil penalty.</p>
              </div>
            </div>
            <div className="flex gap-3">
              <span className="shrink-0 w-7 h-7 rounded-full bg-mt-green text-white font-bold text-xs flex items-center justify-center">2</span>
              <div>
                <p className="font-semibold text-mt-dark">Send the suggested template</p>
                <p className="text-xs text-gray-600 mt-0.5">One click sends a pre-written email to the borrower explaining the issue + a Calendly link to book a 15-min call with our team.</p>
              </div>
            </div>
            <div className="flex gap-3">
              <span className="shrink-0 w-7 h-7 rounded-full bg-mt-green text-white font-bold text-xs flex items-center justify-center">3</span>
              <div>
                <p className="font-semibold text-mt-dark">We resolve, your loan moves</p>
                <p className="text-xs text-gray-600 mt-0.5">Borrower books, ModernTax handles IRS resolution. Email reply-to is your address so you stay in the loop.</p>
              </div>
            </div>
          </div>
        </div>

        {/* Top-line metrics */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
          <div className="bg-white rounded-lg shadow p-5 border-l-4 border-red-500">
            <p className="text-xs text-gray-500 uppercase font-semibold">Critical — needs action</p>
            <p className="text-3xl font-bold text-red-600 mt-2">{totalCritical}</p>
            <p className="text-xs text-gray-500 mt-1">Liens, levies, balance due, civil penalty, unfiled</p>
          </div>
          <div className="bg-white rounded-lg shadow p-5 border-l-4 border-amber-400">
            <p className="text-xs text-gray-500 uppercase font-semibold">All flagged borrowers</p>
            <p className="text-3xl font-bold text-amber-600 mt-2">{entities.length}</p>
            <p className="text-xs text-gray-500 mt-1">Across every loan in your team&apos;s pipeline</p>
          </div>
          <div className="bg-white rounded-lg shadow p-5 border-l-4 border-mt-green">
            <p className="text-xs text-gray-500 uppercase font-semibold">Total IRS exposure</p>
            <p className="text-3xl font-bold text-mt-dark mt-2">{fmtMoney(totalExposure)}</p>
            <p className="text-xs text-gray-500 mt-1">Outstanding balances + penalties + interest</p>
          </div>
        </div>

        {/* Empty state */}
        {entities.length === 0 ? (
          <div className="bg-white rounded-lg shadow border border-gray-200 p-12 text-center">
            <svg className="w-14 h-14 text-emerald-400 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-lg font-bold text-mt-dark mb-1">All clear — no flagged borrowers</p>
            <p className="text-sm text-gray-600 max-w-md mx-auto mb-5">
              Every IRS transcript your team has pulled is clean. New compliance findings appear here automatically as transcripts arrive.
            </p>
            <Link
              href="/new"
              className="inline-block px-5 py-2.5 bg-mt-green text-white text-sm font-semibold rounded-lg hover:bg-mt-green/90"
            >
              Submit a new request →
            </Link>
          </div>
        ) : (
          <div className="space-y-8">
            {/* CRITICAL section */}
            {criticalEntities.length > 0 && (
              <CategorySection
                title="Critical — resolve before closing"
                subtitle={`${criticalEntities.length} borrower${criticalEntities.length === 1 ? '' : 's'} with active IRS issues that will block SBA approval.`}
                badgeColor="red"
                entities={criticalEntities}
                fmtMoney={fmtMoney}
              />
            )}

            {/* WARNING section */}
            {warningEntities.length > 0 && (
              <CategorySection
                title="Warnings — informational"
                subtitle={`${warningEntities.length} borrower${warningEntities.length === 1 ? '' : 's'} with findings that may not block but should be disclosed to the lender.`}
                badgeColor="amber"
                entities={warningEntities}
                fmtMoney={fmtMoney}
              />
            )}
          </div>
        )}

        {entities.length > 0 && (
          <div className="mt-8 bg-blue-50 border border-blue-200 rounded-lg p-5 flex items-start gap-3">
            <svg className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.76c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.184-4.183a1.14 1.14 0 01.778-.332 48.294 48.294 0 005.83-.498c1.585-.233 2.708-1.626 2.708-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
            </svg>
            <div className="text-sm text-blue-900">
              <p className="font-semibold mb-1">Every outreach email includes a 15-min Calendly link to book a resolution call with the ModernTax team.</p>
              <p className="text-xs text-blue-800">
                The borrower books, we handle the IRS resolution (installment agreements, lien releases, abatements, audit response). Reply-to is your email so you see every borrower response. The loan moves forward, you collect.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Category section — renders a header + a table of entities
// ─────────────────────────────────────────────────────────────────────
interface CategoryProps {
  title: string;
  subtitle: string;
  badgeColor: 'red' | 'amber';
  entities: any[];
  fmtMoney: (n: number) => string;
}

function CategorySection({ title, subtitle, badgeColor, entities, fmtMoney }: CategoryProps) {
  const headerColors = badgeColor === 'red'
    ? { dot: 'bg-red-500', title: 'text-red-700', border: 'border-red-200', bg: 'bg-red-50' }
    : { dot: 'bg-amber-500', title: 'text-amber-700', border: 'border-amber-200', bg: 'bg-amber-50' };

  return (
    <section>
      <div className={`flex items-start gap-3 p-4 rounded-t-lg border-x border-t ${headerColors.border} ${headerColors.bg}`}>
        <span className={`w-3 h-3 rounded-full ${headerColors.dot} mt-1.5`} />
        <div className="flex-1">
          <h2 className={`text-base font-bold ${headerColors.title}`}>{title}</h2>
          <p className="text-xs text-gray-700 mt-0.5">{subtitle}</p>
        </div>
        <span className="text-xs font-semibold text-gray-700">{entities.length} borrower{entities.length === 1 ? '' : 's'}</span>
      </div>

      <div className={`bg-white rounded-b-lg border ${headerColors.border} divide-y divide-gray-100`}>
        {entities.map((e) => (
          <EntityRow key={e.id} entity={e} fmtMoney={fmtMoney} />
        ))}
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Entity row — borrower → finding → action, in one readable card
// ─────────────────────────────────────────────────────────────────────
function EntityRow({ entity, fmtMoney }: { entity: any; fmtMoney: (n: number) => string }) {
  const topFlag = entity.all_flags[0]; // for the "headline" finding text
  return (
    <div className="p-5 flex flex-col lg:flex-row lg:items-start gap-4 hover:bg-gray-50/60 transition-colors">
      {/* Left: borrower + loan + flags */}
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-2">
          <h3 className="text-base font-bold text-mt-dark truncate">{entity.entity_name}</h3>
          <Link href={`/request/${entity.request_id}`} className="text-xs text-blue-600 hover:underline font-mono whitespace-nowrap">
            Loan #{entity.loan_number}
          </Link>
          {entity.signer_email ? (
            <span className="text-xs text-gray-500 truncate">{entity.signer_email}</span>
          ) : (
            <span className="text-xs text-amber-700 font-semibold">⚠ no email on file</span>
          )}
        </div>

        {/* Flag chips with plain-English labels */}
        <div className="flex flex-wrap gap-1.5 mb-3">
          {entity.all_flags.slice(0, 5).map((f: any, i: number) => {
            const display = flagDisplay(f.type);
            const isCrit = f.severity === 'CRITICAL';
            return (
              <span
                key={i}
                title={f.message}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold ${
                  isCrit ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'
                }`}
              >
                <span>{display.icon}</span>
                <span>{display.label}</span>
              </span>
            );
          })}
          {entity.all_flags.length > 5 && (
            <span className="text-[11px] text-gray-500 self-center">+{entity.all_flags.length - 5} more</span>
          )}
        </div>

        {/* Headline finding — first flag's message, in plain English */}
        {topFlag && (
          <p className="text-sm text-gray-700 leading-relaxed">
            <span className="font-semibold text-mt-dark">Top finding: </span>
            {topFlag.message}
          </p>
        )}
      </div>

      {/* Middle: exposure */}
      <div className="lg:w-32 lg:text-right shrink-0">
        <p className="text-xs text-gray-500 uppercase font-semibold">IRS exposure</p>
        <p className="text-lg font-bold text-mt-dark font-mono">
          {entity.total_exposure > 0 ? fmtMoney(entity.total_exposure) : '—'}
        </p>
      </div>

      {/* Right: suggested template + send action */}
      <div className="lg:w-72 shrink-0 bg-gray-50 rounded-lg p-3 border border-gray-200">
        <p className="text-[10px] uppercase font-bold text-gray-500 tracking-wide mb-1">Suggested outreach</p>
        <p className="text-sm font-semibold text-mt-dark mb-1">{entity.suggested_template_name || '—'}</p>
        {entity.suggested_template_short && (
          <p className="text-[11px] text-gray-600 mb-3 leading-snug">{entity.suggested_template_short}</p>
        )}
        {entity.signer_email && entity.suggested_template_id ? (
          <ComplianceOutreachButton
            entityId={entity.id}
            entityName={entity.entity_name}
            borrowerEmail={entity.signer_email}
            suggestedTemplateId={entity.suggested_template_id}
            allTemplates={TEMPLATES.map(t => ({ id: t.id, display_name: t.display_name }))}
          />
        ) : (
          <span className="block text-[11px] text-gray-500 italic">
            {!entity.signer_email
              ? 'Add a signer email to the entity to send outreach.'
              : 'No matching template — contact ModernTax for a custom outreach.'}
          </span>
        )}
      </div>
    </div>
  );
}
