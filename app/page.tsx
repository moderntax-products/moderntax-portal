import { redirect } from 'next/navigation';
import { createServerComponentClient } from '@/lib/supabase-server';
import Link from 'next/link';
import { LogoutButton } from '@/components/LogoutButton';
import { FireAllPending8821sButton } from '@/components/FireAllPending8821sButton';
import { UpgradeYourTeamPanel } from '@/components/UpgradeYourTeamPanel';
import { ProcessorUpgradeCTAs } from '@/components/ProcessorUpgradeCTAs';
import { AskAIPanel } from '@/components/AskAIPanel';
import { PremiumSlaSurface } from '@/components/PremiumSlaSurface';
import { getClassificationLabel, getClassificationColor } from '@/lib/mask';

export default async function DashboardPage({
  searchParams,
}: {
  searchParams?: Promise<{ search?: string; status?: string; mine?: string }>;
}) {
  const params: { search?: string; status?: string; mine?: string } = searchParams ? await searchParams : {};
  const searchQuery = (params.search ?? '').trim();
  const statusFilter = params.status ?? 'all';
  const mineOnly = params.mine === '1';
  let supabase;
  try {
    supabase = await createServerComponentClient();
  } catch (err) {
    console.error('[dashboard] Failed to create Supabase client:', err);
    redirect('/login');
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select()
    .eq('id', user.id)
    .single() as { data: { id: string; email: string; full_name: string | null; role: string; client_id: string | null; onboarding_completed_at: string | null; onboarding_dismissed_at: string | null; approval_status?: string | null } | null; error: any };

  if (profileError || !profile) {
    redirect('/login');
  }

  // Pending-approval gate: new sign-ups land in 'pending' until an admin
  // assigns a client_id and approves. Until then, they bounce to a
  // friendly review-status page so they can't access dashboard or any
  // child route via direct navigation.
  if (profile.approval_status === 'pending') {
    redirect('/login?status=pending-review');
  }
  if (profile.approval_status === 'rejected') {
    redirect('/login?status=rejected');
  }

  const isManager = profile.role === 'manager';
  const isAdmin = profile.role === 'admin';
  const isProcessor = profile.role === 'processor';
  const isExpert = profile.role === 'expert';
  // True until the user finishes or dismisses the /onboarding tour.
  // Drives the "Take the tour" banner on the dashboard. Help link in
  // nav stays visible even after dismissal so they can re-take it.
  const showOnboardingBanner = !profile.onboarding_completed_at && !profile.onboarding_dismissed_at;

  // Experts have their own dashboard
  if (isExpert) {
    redirect('/expert');
  }

  // Fetch requests scoped by role:
  // - Processor: only own requests
  // - Manager/Admin: all client requests
  let requests: any[] = [];
  let allClientRequests: any[] = [];
  let stats = {
    total: 0,
    pending: 0,
    completedThisWeek: 0,
    avgTurnaround: 0,
  };

  // For manager team breakdown
  let teamProfiles: { id: string; full_name: string | null; email: string }[] = [];
  let officerStats: Record<string, { name: string; total: number; completed: number; pending: number; amount: number }> = {};

  // Fetch client record for free trial status + add-on toggles + payment
  // method state. Drives:
  //   - Manager "Upgrade Your Team" panel (toggles)
  //   - Processor inline upgrade CTAs (ask-your-manager mailto)
  //   - Trial-counter banner ("X of 3 free pulls used") — visible to all roles
  //   - Payment-method-required banner (when trial used + no method on file)
  let clientFreeTrial = true; // default: trial active
  let monitoringDefaultEnabled = true;
  let cashFlowAutoAttach = false;
  let monitoredEntitiesCount = 0;
  let unmonitoredCompletedCount = 0;
  let hasPaymentMethod = false;
  let paymentMethodLabel: string | null = null;
  // Per-client billing rates — drive both the manager officer-stat revenue
  // breakdown AND the dollar-amount labels on the dashboard. Defaults to the
  // standard tier rates if a client doesn't have overrides set.
  let clientBillingRatePdf = 59.98;
  let clientBillingRateCsv = 69.98;
  // SLA tier — server-rendered into PremiumSlaSurface so the component
  // never silently fails on a client-side RLS error. Two-phase select
  // (with column-existence fallback) so pre-migration envs still load.
  let clientSlaTier: 'standard' | 'premium' | null = null;
  if (profile.client_id) {
    const baseSelect = 'free_trial, monitoring_default_enabled, cash_flow_auto_attach, stripe_payment_method_id, payment_method_status, payment_method_brand, payment_method_last4, payment_method_type, billing_rate_pdf, billing_rate_csv';
    const fullSelect = `${baseSelect}, sla_tier`;
    let clientRecord: any = null;
    {
      const r = await supabase.from('clients').select(fullSelect).eq('id', profile.client_id).single() as { data: any; error: any };
      if (r.error && /sla_tier|column .* does not exist|PGRST204/i.test(r.error.message || '')) {
        const r2 = await supabase.from('clients').select(baseSelect).eq('id', profile.client_id).single() as { data: any; error: any };
        clientRecord = r2.data;
      } else {
        clientRecord = r.data;
      }
    }
    if (clientRecord?.sla_tier === 'premium' || clientRecord?.sla_tier === 'standard') {
      clientSlaTier = clientRecord.sla_tier;
    }
    if (typeof clientRecord?.billing_rate_pdf === 'number') clientBillingRatePdf = clientRecord.billing_rate_pdf;
    if (typeof clientRecord?.billing_rate_csv === 'number') clientBillingRateCsv = clientRecord.billing_rate_csv;
    if (clientRecord?.free_trial === false) clientFreeTrial = false;
    if (clientRecord?.monitoring_default_enabled === false) monitoringDefaultEnabled = false;
    if (clientRecord?.cash_flow_auto_attach === true) cashFlowAutoAttach = true;
    hasPaymentMethod =
      !!clientRecord?.stripe_payment_method_id && clientRecord?.payment_method_status === 'active';
    if (clientRecord?.payment_method_last4) {
      const brand = (clientRecord.payment_method_brand || '').replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
      paymentMethodLabel = `${brand || (clientRecord.payment_method_type === 'us_bank_account' ? 'Bank account' : 'Card')} ending in ${clientRecord.payment_method_last4}`;
    }

    // Counts that drive the upgrade-CTA copy: "You have X completed loans
    // not in monitoring — enable now → ~$Y MRR". Cheap aggregate queries.
    const { count: monCount } = await supabase
      .from('entity_monitoring')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', profile.client_id)
      .in('status', ['active', 'paused']) as { count: number | null };
    monitoredEntitiesCount = monCount || 0;

    const { count: completedCount } = await supabase
      .from('request_entities')
      .select('id, requests!inner(client_id)', { count: 'exact', head: true })
      .eq('requests.client_id', profile.client_id)
      .eq('status', 'completed')
      .neq('form_type', 'W2_INCOME') as { count: number | null };
    unmonitoredCompletedCount = Math.max(0, (completedCount || 0) - monitoredEntitiesCount);
  }

  // Trial counter — total completed entities for THIS client (W2 included
  // because trial counts every entity, not just monitorable ones). Drives
  // the "X of 3 free pulls used" banner + the gate enforcement messaging.
  let totalCompletedEntities = 0;
  let hasRecentPaidInvoice = false;
  if (profile.client_id) {
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const [trialCountRes, paidInvRes] = await Promise.all([
      supabase
        .from('request_entities')
        .select('id, requests!inner(client_id)', { count: 'exact', head: true })
        .eq('requests.client_id', profile.client_id)
        .eq('status', 'completed'),
      supabase
        .from('invoices')
        .select('id', { count: 'exact', head: true })
        .eq('client_id', profile.client_id)
        .eq('status', 'paid')
        .gte('paid_at', ninetyDaysAgo.toISOString()),
    ]);
    totalCompletedEntities = (trialCountRes as any).count || 0;
    hasRecentPaidInvoice = ((paidInvRes as any).count || 0) > 0;
  }
  const TRIAL_FREE_PULLS = 3;
  const trialRemaining = Math.max(0, TRIAL_FREE_PULLS - totalCompletedEntities);
  const trialExhausted = trialRemaining === 0;
  // Hard-block ordering ONLY when trial is used AND no Stripe card AND no
  // recent paid invoice. Established Mercury ACH customers (who have a paid
  // invoice in the last 90 days) keep ordering normally — manager still gets
  // a softer nudge to add a Stripe card for in-app purchases.
  const needsPaymentMethod = trialExhausted && !hasPaymentMethod && !hasRecentPaidInvoice;
  const managerShouldAddCard = trialExhausted && !hasPaymentMethod && hasRecentPaidInvoice;

  // Find the team's manager so processors can ping them via the upgrade CTAs'
  // "Ask your manager" mailto link. Picks the first manager by created_at.
  // Falls back silently to a generic /invoicing link when no manager exists.
  let teamManagerEmail: string | null = null;
  if (profile.client_id && isProcessor) {
    const { data: mgr } = await supabase
      .from('profiles')
      .select('email')
      .eq('client_id', profile.client_id)
      .eq('role', 'manager')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle() as { data: { email: string } | null; error: any };
    teamManagerEmail = mgr?.email || null;
  }

  if (profile.client_id) {
    // Cross-team visibility (B3.1 MVP, Robert/Enterprise Bank Apr 27 ask):
    // every team member — processor, manager, admin — gets the FULL list of
    // client requests so they can search across the org. Submission ownership
    // is preserved via requested_by (only owner can edit/cancel) but visibility
    // is now org-wide. Robert: "anyone on the team should be able to search a
    // profile and see all recent pulls."
    const query = supabase
      .from('requests')
      .select('*, request_entities(id, status, completed_at, created_at, entity_name, tid)')
      .eq('client_id', profile.client_id)
      .order('created_at', { ascending: false });

    const { data: fetchedRequests, error: requestsError } = await query as { data: any[] | null; error: any };

    if (!requestsError && fetchedRequests) {
      allClientRequests = fetchedRequests;
      requests = fetchedRequests;

      // Count at entity level (each EIN/SSN is a unique request unit)
      const allEntities = fetchedRequests.flatMap((r: any) => r.request_entities || []);
      stats.total = allEntities.length;
      stats.pending = allEntities.filter((e: any) => e.status !== 'completed' && e.status !== 'failed').length;

      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);
      // Count entities completed this week (entities have completed_at via expert flow)
      const completedEntities = allEntities.filter((e: any) => e.status === 'completed');
      stats.completedThisWeek = completedEntities.filter(
        (e: any) => e.completed_at && new Date(e.completed_at) > weekAgo
      ).length;

      if (completedEntities.length > 0) {
        // Average turnaround per entity (use entity created_at to completed_at)
        const entitiesWithTimes = completedEntities.filter((e: any) => e.completed_at && e.created_at);
        if (entitiesWithTimes.length > 0) {
          const avgMs =
            entitiesWithTimes.reduce((sum: number, e: any) => {
              return sum + (new Date(e.completed_at).getTime() - new Date(e.created_at).getTime());
            }, 0) / entitiesWithTimes.length;
          stats.avgTurnaround = Math.round(avgMs / (1000 * 60 * 60 * 24));
        }
      }
    }

    // For managers: fetch team profiles and build per-officer breakdown
    if (isManager || isAdmin) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, email')
        .eq('client_id', profile.client_id) as { data: { id: string; full_name: string | null; email: string }[] | null; error: any };

      if (profiles) {
        teamProfiles = profiles;

        // Build name lookup
        const nameLookup: Record<string, string> = {};
        profiles.forEach((p) => {
          nameLookup[p.id] = p.full_name || p.email;
        });

        // Billing rates by intake method — pulled from clients.billing_rate_*
        // so the officer-stat revenue breakdown matches the actual contract
        // rate (Cal Statewide is on $79.98 flat, Centerstone on $59.98/$69.98).
        // Was previously hardcoded → wrong revenue numbers for any client
        // not on the default tier.
        const RATE_PDF = clientBillingRatePdf;
        const RATE_CSV = clientBillingRateCsv;
        const FREE_ENTITIES_PER_ACCOUNT = 3;

        // Flatten all entities with their request context for entity-level counting
        const allEntityRows = allClientRequests.flatMap((req: any) =>
          (req.request_entities || []).map((e: any) => ({
            ...e,
            requested_by: req.requested_by,
            intake_method: req.intake_method,
            request_created_at: req.created_at,
          }))
        );

        // Free trial gives first 3 entities free (sorted by creation time)
        let freeEntityIds = new Set<string>();
        if (clientFreeTrial) {
          const billableEntities = allEntityRows
            .filter((e: any) => e.status !== 'failed')
            .sort((a: any, b: any) => new Date(a.created_at || a.request_created_at).getTime() - new Date(b.created_at || b.request_created_at).getTime());
          freeEntityIds = new Set(billableEntities.slice(0, FREE_ENTITIES_PER_ACCOUNT).map((e: any) => e.id));
        }

        // Build per-officer stats from all entities
        allEntityRows.forEach((entity: any) => {
          const officerId = entity.requested_by;
          const officerName = nameLookup[officerId] || 'Unknown';

          if (!officerStats[officerId]) {
            officerStats[officerId] = { name: officerName, total: 0, completed: 0, pending: 0, amount: 0 };
          }
          officerStats[officerId].total += 1;

          const rate = entity.intake_method === 'csv' ? RATE_CSV : RATE_PDF;
          const isFreeEntity = freeEntityIds.has(entity.id);

          if (entity.status === 'completed') {
            officerStats[officerId].completed += 1;
            if (!isFreeEntity) {
              officerStats[officerId].amount += rate;
            }
          } else if (entity.status === 'failed') {
            // Don't count failed entities as pending
          } else {
            officerStats[officerId].pending += 1;
            // Signed/in-progress entities are also billable
            if (['8821_signed', 'irs_queue', 'processing', 'completed'].includes(entity.status)) {
              if (!isFreeEntity) {
                officerStats[officerId].amount += rate;
              }
            }
          }
        });
      }
    }
  }

  const getStatusBadgeColor = (status: string) => {
    switch (status) {
      case 'submitted':
      case '8821_sent':
        return 'bg-blue-100 text-blue-800';
      case '8821_signed':
      case 'irs_queue':
        return 'bg-yellow-100 text-yellow-800';
      case 'processing':
        return 'bg-purple-100 text-purple-800';
      case 'completed':
        return 'bg-green-100 text-green-800';
      case 'failed':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const formatStatus = (status: string) => {
    switch (status) {
      case 'irs_queue': return 'IRS Queue';
      case '8821_sent': return '8821 Sent';
      case '8821_signed': return '8821 Signed';
      default:
        return status
          .split('_')
          .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
          .join(' ');
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const intakeMethodLabel = (method: string) => {
    switch (method) {
      case 'csv': return 'CSV';
      case 'pdf': return 'PDF';
      case 'manual': return 'Manual';
      default: return method;
    }
  };

  // Apply search and status filters to the requests shown in the table
  const pendingStatuses = ['submitted', '8821_sent', '8821_signed', 'irs_queue', 'processing'];

  // Cross-team search (B3.1): match loan_number AND any entity name AND any
  // last-4-digit TID. Lets a processor type "Aguirre" or "44592" and find the
  // request even if a teammate created it.
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    requests = requests.filter((r: any) => {
      if (r.loan_number?.toLowerCase().includes(q)) return true;
      const ents = r.request_entities || [];
      for (const e of ents) {
        if ((e.entity_name || '').toLowerCase().includes(q)) return true;
        // TID search: match by full TID OR last 4 digits
        const tidDigits = (e.tid || '').replace(/\D/g, '');
        const queryDigits = q.replace(/\D/g, '');
        if (queryDigits && (tidDigits.includes(queryDigits) || tidDigits.endsWith(queryDigits))) return true;
      }
      return false;
    });
  }

  // "Mine only" toggle — when set, narrows back to requests this user created.
  // Default for processors is full-team view (B3.1); they can opt back into
  // single-user view via the toggle.
  if (mineOnly) {
    requests = requests.filter((r: any) => r.requested_by === user.id);
  }

  if (statusFilter === 'pending') {
    requests = requests.filter((r: any) => pendingStatuses.includes(r.status));
  } else if (statusFilter === 'completed') {
    requests = requests.filter((r: any) => r.status === 'completed');
  } else if (statusFilter === 'failed') {
    requests = requests.filter((r: any) => r.status === 'failed');
  }

  // Check MFA enrollment status
  const { data: mfaFactors } = await supabase.auth.mfa.listFactors();
  const hasMfaEnabled = mfaFactors?.totp && mfaFactors.totp.length > 0;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* SOC 2 Data Classification Banner */}
      <div className={`border-b px-4 py-2 text-center text-xs font-semibold tracking-wide ${getClassificationColor('confidential')}`}>
        🔒 {getClassificationLabel('confidential')}
      </div>

      {/* MFA Warning Banner */}
      {!hasMfaEnabled && (
        <div className="bg-red-50 border-b border-red-200 px-4 py-3">
          <div className="max-w-7xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-1.5 bg-red-100 rounded-full">
                <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-semibold text-red-800">Multi-Factor Authentication Not Enabled</p>
                <p className="text-xs text-red-600">SOC 2 requires MFA for all users accessing sensitive data. Please enable MFA in your account settings.</p>
              </div>
            </div>
            <a
              href="/account/security"
              className="text-sm font-semibold text-red-700 hover:text-red-900 underline whitespace-nowrap"
            >
              Enable MFA →
            </a>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-bold text-mt-dark">Dashboard</h1>
            <p className="text-gray-600 mt-1">
              Welcome back, {profile.full_name || user.email}
              {isManager && (
                <span className="ml-2 inline-block px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700">
                  Manager
                </span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {/* Admin Link (only for admins) */}
            {isAdmin && (
              <Link
                href="/admin"
                className="px-4 py-2 text-sm font-medium text-mt-dark border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                ⚙️ Admin
              </Link>
            )}
            {/* Compliance — visible to manager + processor (cross-team B3.1).
                Links to /compliance which shows flagged borrower entities + lets
                anyone fire a resolution-template email. */}
            {(isManager || isProcessor) && (
              <Link
                href="/compliance"
                className="px-4 py-2 text-sm font-medium text-mt-dark border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Compliance
              </Link>
            )}
            {/* Manager Navigation */}
            {isManager && (
              <>
                <Link
                  href="/invoicing"
                  className="px-4 py-2 text-sm font-medium text-mt-dark border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  Invoicing
                </Link>
                <Link
                  href="/team"
                  className="px-4 py-2 text-sm font-medium text-mt-dark border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  My Team
                </Link>
              </>
            )}
            {/* Help — re-take the product tour any time. Visible to all
                non-expert users (processor/manager/admin). */}
            <Link
              href="/onboarding"
              className="px-4 py-2 text-sm font-medium text-mt-dark border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              title="Take the product tour"
            >
              Help
            </Link>
            <Link
              href="/account/security"
              className="px-4 py-2 text-sm font-medium text-mt-dark border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Settings
            </Link>
            {/* MFA Status Badge */}
            {hasMfaEnabled ? (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-green-100 text-green-800">
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                MFA Active
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-red-100 text-red-800">
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                MFA Off
              </span>
            )}
            <Link
              href="/new"
              className="bg-mt-green text-white px-6 py-3 rounded-lg font-semibold hover:bg-opacity-90 transition-colors"
            >
              + New Request
            </Link>
            <LogoutButton />
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        {/* PLACE A NEW ORDER — primary workflow for every user type
            (processor, manager, admin, and any future role). Three big
            cards show the three submission paths at a glance. We keep
            this above EVERYTHING else (stats, trial banner, request
            table) because the entire portal exists to serve this one
            action: order an IRS transcript verification. */}
        <section className="mb-8">
          <div className="flex items-end justify-between mb-4">
            <div>
              <h2 className="text-xl font-bold text-mt-dark">Place a new order</h2>
              <p className="text-sm text-gray-600 mt-0.5">
                Pick your fastest path. Each route ends in transcripts delivered to your portal in 24-48h.
              </p>
            </div>
            {showOnboardingBanner && (
              <Link
                href="/onboarding"
                className="hidden sm:inline-flex items-center gap-1.5 text-xs font-semibold text-mt-green hover:underline"
              >
                Take the 5-min tour →
              </Link>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Link
              href="/new/csv"
              className="group relative bg-white rounded-xl border-2 border-gray-200 hover:border-mt-green hover:shadow-md transition-all p-5 flex flex-col"
            >
              <div className="flex items-center gap-3 mb-2">
                <div className="p-2 rounded-lg bg-blue-50 text-blue-600 group-hover:bg-blue-100 transition-colors">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 00-1.883 2.542l.857 6a2.25 2.25 0 002.227 1.932H19.05a2.25 2.25 0 002.227-1.932l.857-6a2.25 2.25 0 00-1.883-2.542m-16.5 0V6A2.25 2.25 0 016 3.75h3.879a1.5 1.5 0 011.06.44l2.122 2.12a1.5 1.5 0 001.06.44H18A2.25 2.25 0 0120.25 9v.776" />
                  </svg>
                </div>
                <h3 className="font-bold text-mt-dark">CSV / Excel Upload</h3>
              </div>
              <p className="text-sm text-gray-600 flex-1">
                Multiple borrowers at once. We auto-generate the 8821s and send them for signature.
              </p>
              <div className="mt-3 flex items-center gap-2 text-xs">
                <span className="px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 font-semibold">Recommended for batches</span>
                <span className="text-mt-green font-semibold ml-auto group-hover:translate-x-0.5 transition-transform">Start →</span>
              </div>
            </Link>

            <Link
              href="/new/pdf"
              className="group relative bg-white rounded-xl border-2 border-gray-200 hover:border-mt-green hover:shadow-md transition-all p-5 flex flex-col"
            >
              <div className="flex items-center gap-3 mb-2">
                <div className="p-2 rounded-lg bg-amber-50 text-amber-600 group-hover:bg-amber-100 transition-colors">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                  </svg>
                </div>
                <h3 className="font-bold text-mt-dark">Signed 8821 PDF</h3>
              </div>
              <p className="text-sm text-gray-600 flex-1">
                Already have the borrower&apos;s signature? Upload the PDF and we go straight to IRS pulling.
              </p>
              <div className="mt-3 flex items-center gap-2 text-xs">
                <span className="px-2 py-0.5 rounded bg-blue-50 text-blue-700 font-semibold">Skips signature step</span>
                <span className="text-mt-green font-semibold ml-auto group-hover:translate-x-0.5 transition-transform">Start →</span>
              </div>
            </Link>

            <Link
              href="/new/manual"
              className="group relative bg-white rounded-xl border-2 border-gray-200 hover:border-mt-green hover:shadow-md transition-all p-5 flex flex-col"
            >
              <div className="flex items-center gap-3 mb-2">
                <div className="p-2 rounded-lg bg-purple-50 text-purple-600 group-hover:bg-purple-100 transition-colors">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
                  </svg>
                </div>
                <h3 className="font-bold text-mt-dark">Manual Entry</h3>
              </div>
              <p className="text-sm text-gray-600 flex-1">
                One borrower? Type the details directly — fastest path for a single transcript request.
              </p>
              <div className="mt-3 flex items-center gap-2 text-xs">
                <span className="px-2 py-0.5 rounded bg-purple-50 text-purple-700 font-semibold">~30 seconds</span>
                <span className="text-mt-green font-semibold ml-auto group-hover:translate-x-0.5 transition-transform">Start →</span>
              </div>
            </Link>
          </div>
        </section>

        {/* "Take the tour" — gentle nudge for users who haven't onboarded.
            Sits below the order paths so it never blocks the primary CTA. */}
        {showOnboardingBanner && (
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-full bg-white">
                <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-semibold text-blue-900">New here? Take the 5-minute tour.</p>
                <p className="text-xs text-blue-700 mt-0.5">
                  Walks you through ordering, compliance flags, monitoring, billing, and team setup.
                </p>
              </div>
            </div>
            <Link
              href="/onboarding"
              className="shrink-0 inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              Start tour →
            </Link>
          </div>
        )}

        {/* CRITICAL BANNER — trial exhausted AND no payment method on file.
            Blocks new orders; the gate at /api/upload/* returns 402 until
            the manager attaches a method via /payment-method. Visible to all
            roles so the whole team understands why uploads are failing. */}
        {needsPaymentMethod && (
          <div className="rounded-xl shadow p-5 mb-6 bg-gradient-to-br from-red-50 to-amber-50 border-2 border-red-300">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="flex items-start gap-3 flex-1">
                <div className="shrink-0 w-12 h-12 rounded-lg bg-red-100 flex items-center justify-center">
                  <svg className="w-6 h-6 text-red-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-lg font-bold text-red-900">New orders paused — payment method required</h3>
                  <p className="text-sm text-red-800 mt-1 leading-relaxed">
                    Your team has used all {TRIAL_FREE_PULLS} free trial pulls ({totalCompletedEntities} completed). Add a card or bank account to keep ordering. Auto-charges happen at completion at your tier&rsquo;s per-pull rate — no setup fee, cancel anytime.
                  </p>
                  {!isManager && (
                    <p className="text-xs text-red-700 mt-2 italic">
                      Only your manager can attach a payment method. Forward this page to your manager or email matt@moderntax.io.
                    </p>
                  )}
                </div>
              </div>
              {(isManager || isAdmin) && (
                <Link
                  href="/payment-method"
                  className="shrink-0 inline-flex items-center gap-2 px-4 py-2.5 text-sm font-bold bg-red-600 text-white rounded-lg hover:bg-red-700"
                >
                  Add payment method →
                </Link>
              )}
            </div>
          </div>
        )}

        {/* SOFTER NUDGE — manager-only — for established Mercury ACH customers
            (Centerstone, Cal Statewide, etc.) who have a recent paid invoice
            so ordering still flows, but who haven't yet attached a Stripe
            card for in-app one-off charges (cash-flow pack, monitoring, tier
            upgrades). Hidden for processors — they shouldn't see billing nags. */}
        {managerShouldAddCard && isManager && (
          <div className="rounded-xl p-4 mb-6 bg-blue-50 border border-blue-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-start gap-3 flex-1">
              <div className="shrink-0 w-9 h-9 rounded-lg bg-blue-100 flex items-center justify-center">
                <svg className="w-5 h-5 text-blue-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h.01M11 15h2m4-9H7a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2V8a2 2 0 00-2-2z" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-semibold text-blue-900">Add a card for instant in-app purchases</p>
                <p className="text-xs text-blue-800 mt-0.5">
                  Your account is current — your team keeps ordering on Mercury ACH (monthly invoices). Add a Stripe card to enable instant cash-flow packs, monitoring upgrades, and tier upgrades without waiting for the next invoice cycle.
                </p>
              </div>
            </div>
            <Link
              href="/payment-method"
              className="shrink-0 inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold bg-blue-600 text-white rounded-lg hover:bg-blue-700 whitespace-nowrap"
            >
              Add card →
            </Link>
          </div>
        )}

        {/* QUIET INFO BAR — payment method on file. Lets managers see "method
            attached" status at a glance + jump to replace it. Auto-hides for
            processors (clutter). */}
        {hasPaymentMethod && (isManager || isAdmin) && paymentMethodLabel && (
          <div className="rounded-lg p-3 mb-4 bg-emerald-50 border border-emerald-200 flex items-center justify-between gap-3 flex-wrap">
            <p className="text-xs text-emerald-900 flex items-center gap-2">
              <svg className="w-4 h-4 text-emerald-700" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd"/>
              </svg>
              <strong>Payment method on file:</strong> {paymentMethodLabel} · auto-charge enabled
            </p>
            <Link href="/payment-method" className="text-xs font-semibold text-emerald-700 hover:underline">
              Manage →
            </Link>
          </div>
        )}

        {/* Trial Progress Banner — manager + processor visible (so the
            whole team sees the credits they share). Surfaces the dollar
            value ($239.94 = 3 × $79.98 per-TIN reference rate) so the
            credit feels real, not abstract. Visible to processors too —
            credits are account-wide, anyone on the team can use them. */}
        {(isManager || isProcessor) && clientFreeTrial && (() => {
          const completedCount = (allClientRequests || [])
            .flatMap((r: any) => r.request_entities || [])
            .filter((e: any) => e.status === 'completed').length;
          const FREE = 3;
          const TRIAL_RATE = 79.98;
          const TRIAL_TOTAL = FREE * TRIAL_RATE; // $239.94
          const usedFree = Math.min(FREE, completedCount);
          const remainingFree = Math.max(0, FREE - usedFree);
          const remainingValue = remainingFree * TRIAL_RATE;
          const pct = Math.round((usedFree / FREE) * 100);
          const exhausted = remainingFree === 0;
          return (
            <div className={`rounded-xl shadow p-5 mb-6 border ${exhausted ? 'bg-amber-50 border-amber-300' : 'bg-gradient-to-br from-emerald-50 to-emerald-100/40 border-emerald-300'}`}>
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div className="flex items-start gap-4 flex-1">
                  <div className="shrink-0 w-12 h-12 rounded-lg bg-white shadow-sm flex items-center justify-center">
                    <span className="text-2xl">{exhausted ? '⏰' : '🎁'}</span>
                  </div>
                  <div className="flex-1">
                    <div className="flex flex-wrap items-baseline gap-2 mb-1">
                      <h3 className={`text-lg font-bold ${exhausted ? 'text-amber-900' : 'text-emerald-900'}`}>
                        {exhausted ? 'Free trial complete' : 'Free trial credit'}
                      </h3>
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${exhausted ? 'bg-amber-200 text-amber-900' : 'bg-emerald-200/60 text-emerald-700'}`}>
                        {usedFree} of {FREE} used
                      </span>
                    </div>
                    {exhausted ? (
                      <p className="text-sm text-amber-900">
                        You&apos;ve used all 3 free transcripts (${TRIAL_TOTAL.toFixed(2)} value). New requests bill at your contract rate.
                      </p>
                    ) : (
                      <p className="text-sm text-emerald-900">
                        <span className="font-bold text-2xl">${remainingValue.toFixed(2)}</span>
                        <span className="ml-1.5 text-emerald-800">remaining</span>
                        <span className="ml-2 text-xs text-emerald-700">· {remainingFree} free request{remainingFree === 1 ? '' : 's'} for your entire team{isProcessor ? '' : ' (processors + managers)'}</span>
                      </p>
                    )}
                    <div className="mt-3 h-2 bg-white/60 rounded-full overflow-hidden border border-black/5">
                      <div
                        className={`h-full transition-all ${exhausted ? 'bg-amber-500' : 'bg-emerald-500'}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                </div>
                <Link
                  href={exhausted && isManager ? (hasPaymentMethod ? '/invoicing' : '/payment-method') : '/new'}
                  className={`shrink-0 inline-flex items-center gap-2 px-4 py-2 text-sm font-bold rounded-lg transition-colors ${
                    exhausted
                      ? 'bg-amber-600 text-white hover:bg-amber-700'
                      : 'bg-mt-green text-white hover:bg-mt-green/90'
                  }`}
                >
                  {exhausted
                    ? isManager
                      ? hasPaymentMethod ? 'View billing →' : 'Add payment method →'
                      : 'Submit request →'
                    : 'Use credit →'}
                </Link>
              </div>
            </div>
          );
        })()}

        {/* Premium SLA — banner for standard accounts (upgrade CTA), badge
            for premium accounts (Cal Statewide today). Driver: 2026-05-28
            productized same-day SLA tier. Tier is server-rendered to avoid
            a class of client-side silent failures (RLS + missing-column). */}
        <div className="mb-6">
          <PremiumSlaSurface tier={clientSlaTier} variant="banner" />
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-12">
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-600 text-sm font-medium">
                  {isProcessor ? 'My Entities' : 'Team Entities'}
                </p>
                <p className="text-3xl font-bold text-mt-dark mt-2">{stats.total}</p>
              </div>
              <div className="p-3 bg-mt-green bg-opacity-10 rounded-lg">
                <svg className="w-6 h-6 text-mt-green" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-600 text-sm font-medium">Active</p>
                <p className="text-3xl font-bold text-mt-dark mt-2">{stats.pending}</p>
              </div>
              <div className="p-3 bg-yellow-100 rounded-lg">
                <svg className="w-6 h-6 text-yellow-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-600 text-sm font-medium">Completed (7 days)</p>
                <p className="text-3xl font-bold text-mt-dark mt-2">{stats.completedThisWeek}</p>
              </div>
              <div className="p-3 bg-green-100 rounded-lg">
                <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-600 text-sm font-medium">
                  {isManager ? 'Team Members' : 'Avg Turnaround'}
                </p>
                <p className="text-3xl font-bold text-mt-dark mt-2">
                  {isManager
                    ? teamProfiles.length
                    : stats.avgTurnaround > 0 ? `${stats.avgTurnaround}d` : 'N/A'}
                </p>
              </div>
              <div className="p-3 bg-blue-100 rounded-lg">
                <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  {isManager ? (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                  ) : (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  )}
                </svg>
              </div>
            </div>
          </div>
        </div>

        {/* Manager: Team Breakdown by Loan Officer */}
        {(isManager || isAdmin) && Object.keys(officerStats).length > 0 && (
          <div className="bg-white rounded-lg shadow overflow-hidden mb-12">
            <div className="px-6 py-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-mt-dark">Breakdown by Loan Officer</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Loan Officer</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Total</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Completed</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Pending</th>
                    <th className="px-6 py-3 text-right text-sm font-semibold text-gray-700">Est. Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {Object.entries(officerStats)
                    .sort(([, a], [, b]) => b.total - a.total)
                    .map(([officerId, oStats]) => (
                      <tr key={officerId} className="hover:bg-gray-50 transition-colors">
                        <td className="px-6 py-4">
                          <span className="text-sm font-semibold text-mt-dark">{oStats.name}</span>
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">{oStats.total}</td>
                        <td className="px-6 py-4">
                          <span className="text-sm font-medium text-green-600">{oStats.completed}</span>
                        </td>
                        <td className="px-6 py-4">
                          <span className="text-sm font-medium text-yellow-600">{oStats.pending}</span>
                        </td>
                        <td className="px-6 py-4 text-right">
                          <span className="text-sm font-semibold text-gray-900">
                            ${oStats.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </span>
                        </td>
                      </tr>
                    ))}
                  {/* Totals row */}
                  <tr className="bg-gray-50 font-semibold">
                    <td className="px-6 py-3 text-sm text-mt-dark">TOTAL</td>
                    <td className="px-6 py-3 text-sm text-gray-900">
                      {Object.values(officerStats).reduce((s, o) => s + o.total, 0)}
                    </td>
                    <td className="px-6 py-3 text-sm text-green-600">
                      {Object.values(officerStats).reduce((s, o) => s + o.completed, 0)}
                    </td>
                    <td className="px-6 py-3 text-sm text-yellow-600">
                      {Object.values(officerStats).reduce((s, o) => s + o.pending, 0)}
                    </td>
                    <td className="px-6 py-3 text-sm text-right text-gray-900">
                      ${Object.values(officerStats).reduce((s, o) => s + o.amount, 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* "Upgrade Your Team" panel — bulk add-on toggles. Manager + admin can see
            it; processors get the slimmer banner instead. Admins viewing the
            generic dashboard see it scoped to their own profile.client_id (when
            set) — admins without a client should use /admin where each client
            row exposes the same toggles inline. */}
        {(isManager || isAdmin) && profile.client_id && (
          <UpgradeYourTeamPanel
            clientId={profile.client_id}
            monitoringDefaultEnabled={monitoringDefaultEnabled}
            cashFlowAutoAttach={cashFlowAutoAttach}
            monitoredEntitiesCount={monitoredEntitiesCount}
            unmonitoredCompletedCount={unmonitoredCompletedCount}
          />
        )}

        {/* Processor-only — slim "ask your manager to enable X" banner. Self-hides
            when the team has no completed entities or both add-ons are already on. */}
        {isProcessor && profile.client_id && (
          <ProcessorUpgradeCTAs
            monitoringDefaultEnabled={monitoringDefaultEnabled}
            monitoredEntitiesCount={monitoredEntitiesCount}
            unmonitoredCompletedCount={unmonitoredCompletedCount}
            cashFlowAutoAttach={cashFlowAutoAttach}
            managerEmail={teamManagerEmail}
            processorName={profile.full_name || undefined}
          />
        )}

        {/* Recent Requests Table */}
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-mt-dark">
                {mineOnly ? 'My Requests' : 'All Team Requests'}
                <span className="ml-2 text-xs font-normal text-gray-500">{requests.length} shown</span>
              </h2>
              <div className="flex flex-wrap items-center gap-3">
                {/* Bulk fire-all-pending-8821s — visible to processor + manager.
                    The component fetches its own live count and is a no-op if
                    the team has zero pending 8821s. Used to be admin-only;
                    opening it up to processors saves them ~30 clicks per
                    multi-entity loan upload. Server enforces client scope so a
                    processor can never accidentally fire across tenants. */}
                {(isProcessor || isManager) && profile.client_id && (
                  <FireAllPending8821sButton
                    clientId={profile.client_id}
                    label="Fire team pending 8821s"
                  />
                )}
                {/* Mine vs Team toggle — every team member can see the full org's
                    request list now (B3.1 cross-team visibility). They can flip
                    to "Mine only" if they prefer the single-user view. */}
                <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs">
                  <Link
                    href={`/${searchQuery ? `?search=${encodeURIComponent(searchQuery)}` : ''}${searchQuery && statusFilter !== 'all' ? '&' : (statusFilter !== 'all' ? '?' : '')}${statusFilter !== 'all' ? `status=${statusFilter}` : ''}`}
                    className={`px-3 py-1.5 font-semibold transition-colors ${!mineOnly ? 'bg-mt-dark text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                  >
                    Whole Team
                  </Link>
                  <Link
                    href={`/?mine=1${searchQuery ? `&search=${encodeURIComponent(searchQuery)}` : ''}${statusFilter !== 'all' ? `&status=${statusFilter}` : ''}`}
                    className={`px-3 py-1.5 font-semibold transition-colors border-l border-gray-200 ${mineOnly ? 'bg-mt-dark text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                  >
                    Mine Only
                  </Link>
                </div>
              </div>
            </div>

            {/* Search and Filter Controls */}
            <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
              {/* Search across loan number, entity name, TID — works whole-team */}
              <form method="GET" className="flex gap-2">
                {statusFilter !== 'all' && <input type="hidden" name="status" value={statusFilter} />}
                {mineOnly && <input type="hidden" name="mine" value="1" />}
                <input
                  type="text"
                  name="search"
                  placeholder="Search by loan, borrower name, or TID..."
                  defaultValue={searchQuery}
                  className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent w-72"
                />
                <button
                  type="submit"
                  className="px-4 py-2 bg-mt-green text-white text-sm font-medium rounded-lg hover:bg-opacity-90 transition-colors"
                >
                  Search
                </button>
                {searchQuery && (
                  <Link
                    href={`/${mineOnly ? '?mine=1' : ''}${mineOnly && statusFilter !== 'all' ? '&' : (statusFilter !== 'all' && !mineOnly ? '?' : '')}${statusFilter !== 'all' ? `status=${statusFilter}` : ''}`}
                    className="px-4 py-2 text-sm font-medium text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    Clear
                  </Link>
                )}
              </form>

              {/* Status filter */}
              <div className="flex gap-1 flex-wrap">
                {[
                  { key: 'all', label: 'All' },
                  { key: 'pending', label: 'Pending' },
                  { key: 'completed', label: 'Completed' },
                  { key: 'failed', label: 'Failed' },
                ].map((opt) => {
                  const href = opt.key === 'all'
                    ? (searchQuery ? `/?search=${encodeURIComponent(searchQuery)}` : '/')
                    : (searchQuery ? `/?search=${encodeURIComponent(searchQuery)}&status=${opt.key}` : `/?status=${opt.key}`);
                  const isActive = statusFilter === opt.key;
                  return (
                    <Link
                      key={opt.key}
                      href={href}
                      className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                        isActive
                          ? 'bg-mt-green text-white'
                          : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                      }`}
                    >
                      {opt.label}
                    </Link>
                  );
                })}
              </div>
            </div>

            {/* Result count */}
            <p className="text-sm text-gray-500">
              Showing {requests.length} request{requests.length !== 1 ? 's' : ''}
            </p>
          </div>

          {requests.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Loan #</th>
                    {(isManager || isAdmin) && (
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Officer</th>
                    )}
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Status</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Source</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Entities</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Submitted</th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {requests.map((request) => {
                    // Find officer name for manager view
                    const officerProfile = teamProfiles.find((p) => p.id === request.requested_by);
                    const officerName = officerProfile?.full_name || officerProfile?.email || '—';

                    return (
                      <tr key={request.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-6 py-4">
                          <code className="text-sm font-mono text-mt-dark">{request.loan_number}</code>
                        </td>
                        {(isManager || isAdmin) && (
                          <td className="px-6 py-4 text-sm text-gray-600">{officerName}</td>
                        )}
                        <td className="px-6 py-4">
                          <span
                            className={`inline-block px-3 py-1 rounded-full text-xs font-semibold ${getStatusBadgeColor(request.status)}`}
                          >
                            {formatStatus(request.status)}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">
                            {intakeMethodLabel(request.intake_method)}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">
                          {request.request_entities?.length || 0}
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">{formatDate(request.created_at)}</td>
                        <td className="px-6 py-4">
                          <Link
                            href={`/request/${request.id}`}
                            className="text-mt-green hover:underline font-medium text-sm"
                          >
                            View
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="px-6 py-12 text-center">
              <svg className="w-16 h-16 text-gray-300 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <p className="text-gray-500 font-medium mb-4">No requests yet</p>
              <p className="text-gray-400 text-sm mb-6">Get started by uploading a CSV or signed 8821 PDF.</p>
              <Link
                href="/new"
                className="inline-block bg-mt-green text-white px-6 py-3 rounded-lg font-semibold hover:bg-opacity-90 transition-colors"
              >
                Create Request
              </Link>
            </div>
          )}
        </div>
      </div>

      {/* In-app Q&A — floating "Ask AI" button. Mount on the dashboard
          so processors / managers / experts have it from the page they
          land on first. Same component works for all roles (server-side
          API gates which roles can call it). */}
      <AskAIPanel />
    </div>
  );
}
