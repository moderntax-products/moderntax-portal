import { redirect } from 'next/navigation';
import { createServerComponentClient } from '@/lib/supabase-server';
import type { RequestStatus } from '@/lib/types';
import Link from 'next/link';
import { getClassificationLabel, getClassificationColor } from '@/lib/mask';
import { FreeTrialToggle } from '@/components/FreeTrialToggle';
import { NotifyProcessorsButton } from '@/components/NotifyProcessorsButton';
import { FireAllPending8821sButton } from '@/components/FireAllPending8821sButton';
import { computeRevenueMetrics, formatDollars } from '@/lib/revenue-metrics';

interface PageProps {
  searchParams: Promise<{
    type?: string;
    search?: string;
    status?: string;
    /** Time window (days) for the All Requests list. Default 7. Use "all" to disable. */
    window?: string;
    /** When true (default), hide requests with HIST-* loan numbers (migration imports). */
    hideLegacy?: string;
    /** Zero-based page index for the All Requests list. Default 0. */
    page?: string;
  }>;
}

/** How many rows the admin "All Requests" list renders per page. */
const ADMIN_REQUESTS_PAGE_SIZE = 50;

export default async function AdminPage({ searchParams }: PageProps) {
  const {
    type: productTypeFilter,
    search: searchFilter,
    status: statusFilter,
    window: windowFilterRaw,
    hideLegacy: hideLegacyRaw,
    page: pageRaw,
  } = await searchParams;

  // Defaults are tuned for "show me what's actively moving":
  //   - window=7 days (recent only)
  //   - hideLegacy=true (exclude HIST-* migration loan numbers)
  //   - sort by updated_at DESC (activity-first) instead of created_at
  //   - pagination at ADMIN_REQUESTS_PAGE_SIZE
  const windowDays = (() => {
    if (!windowFilterRaw) return 7;
    if (windowFilterRaw === 'all') return null;
    const n = parseInt(windowFilterRaw, 10);
    return Number.isFinite(n) && n > 0 ? n : 7;
  })();
  const hideLegacy = hideLegacyRaw !== 'false'; // default true
  const currentPage = (() => {
    const n = parseInt(pageRaw || '0', 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  })();
  const supabase = await createServerComponentClient();

  // Check authentication
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  // Check if user has admin role (role-based access)
  const { data: adminProfile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single() as { data: { role: string } | null; error: any };

  if (!adminProfile || adminProfile.role !== 'admin') {
    redirect('/');
  }

  // Sandbox clients (slug ending in `-sandbox`) are seeded with synthetic
  // EINs/SSNs for prospect curl demos (Vine, Builds Collective, Moxie).
  // They must be excluded from EVERY admin aggregate view — billing, the
  // "All Requests" table, stuck-entity alerts, the bottleneck analysis,
  // and the recent-invoices panel. Filtering at the query level here
  // means every downstream stats/dashboard derivation is sandbox-clean
  // without each consumer having to remember to filter.

  // Fetch all clients (excludes sandboxes)
  const { data: clients, error: clientsError } = await supabase
    .from('clients')
    .select('*')
    .not('slug', 'ilike', '%-sandbox')
    .order('name', { ascending: true }) as { data: { id: string; name: string; slug: string; domain: string | null; free_trial: boolean | null; api_key: string | null; api_request_limit: number | null; billing_payment_method: string | null; billing_ap_email: string | null; billing_ap_phone: string | null; billing_rate_pdf: number; billing_rate_csv: number }[] | null; error: any };

  // Fetch all requests with entities (include completed_at for revenue calc) and client info.
  // NOTE: "allRequests" is used by stats/bottleneck code below and must stay a full-table scan
  //       for accurate counts. The admin's "All Requests" UI below paginates via `visibleRequests`.
  const { data: allRequests, error: requestsError } = await supabase
    .from('requests')
    .select('*, request_entities(id, entity_name, status, completed_at), clients!inner(name, slug)')
    .not('clients.slug', 'ilike', '%-sandbox')
    .order('updated_at', { ascending: false }) as { data: any[] | null; error: any };

  // Fetch invoices for billing overview
  const { data: allInvoices } = await supabase
    .from('invoices')
    .select('*, clients!inner(name, slug)')
    .not('clients.slug', 'ilike', '%-sandbox')
    .order('billing_period_start', { ascending: false })
    .limit(10) as { data: any[] | null; error: any };

  // Real-time revenue + AR metrics pulled from the invoices table (kept in
  // sync with Mercury by the daily mercury-reconcile cron at 05:00 UTC).
  const revenueMetrics = await computeRevenueMetrics(supabase as any);
  const q2ProgressPct = Math.min(
    100,
    (revenueMetrics.totals.projected_q2 / revenueMetrics.q2_target_dollars) * 100,
  );
  const q2GapDollars = Math.max(0, revenueMetrics.q2_target_dollars - revenueMetrics.totals.projected_q2);

  // Query stuck entities — entities in non-terminal statuses for too long
  const now = new Date();
  const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const fortyEightHoursAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();

  const { data: stuckSentEntities } = await supabase
    .from('request_entities')
    .select('id, entity_name, status, updated_at, request_id, requests!inner(loan_number, clients!inner(name, slug))')
    .eq('status', '8821_sent')
    .not('requests.clients.slug', 'ilike', '%-sandbox')
    .lt('updated_at', fiveDaysAgo) as { data: any[] | null; error: any };

  const { data: stuckQueueEntities } = await supabase
    .from('request_entities')
    .select('id, entity_name, status, updated_at, request_id, requests!inner(loan_number, clients!inner(name, slug))')
    .eq('status', 'irs_queue')
    .not('requests.clients.slug', 'ilike', '%-sandbox')
    .lt('updated_at', fortyEightHoursAgo) as { data: any[] | null; error: any };

  const { data: stuckProcessingEntities } = await supabase
    .from('request_entities')
    .select('id, entity_name, status, updated_at, request_id, requests!inner(loan_number, clients!inner(name, slug))')
    .eq('status', 'processing')
    .not('requests.clients.slug', 'ilike', '%-sandbox')
    .lt('updated_at', fortyEightHoursAgo) as { data: any[] | null; error: any };

  // stuckEntities replaced by bottleneck analysis below
  void stuckSentEntities; void stuckQueueEntities; void stuckProcessingEntities;

  // --- Bottleneck Analysis ---
  // Fetch ALL incomplete requests with entities, assignments, and submitter info for bottleneck view
  const { data: incompleteRequests } = await supabase
    .from('requests')
    .select(`
      id, loan_number, status, created_at, client_id, requested_by,
      clients!inner(name, slug),
      profiles!requests_requested_by_fkey(full_name, email, role)
    `)
    .not('status', 'in', '("completed","failed","cancelled")')
    .not('clients.slug', 'ilike', '%-sandbox')
    .order('created_at', { ascending: true }) as { data: any[] | null; error: any };

  const incompleteIds = (incompleteRequests || []).map((r: any) => r.id);
  const { data: incompleteEntities } = await supabase
    .from('request_entities')
    .select('id, request_id, entity_name, status, created_at, updated_at')
    .in('request_id', incompleteIds.length > 0 ? incompleteIds : ['__none__']) as { data: any[] | null; error: any };

  const incEntityIds = (incompleteEntities || []).map((e: any) => e.id);
  const { data: incAssignments } = await supabase
    .from('expert_assignments')
    .select('entity_id, expert_id, status, profiles!expert_assignments_expert_id_fkey(full_name)')
    .in('entity_id', incEntityIds.length > 0 ? incEntityIds : ['__none__'])
    .in('status', ['assigned', 'in_progress']) as { data: any[] | null; error: any };

  const incAssignmentMap = new Map<string, any>();
  (incAssignments || []).forEach((a: any) => incAssignmentMap.set(a.entity_id, a));

  const incEntityMap = new Map<string, any[]>();
  (incompleteEntities || []).forEach((e: any) => {
    if (!incEntityMap.has(e.request_id)) incEntityMap.set(e.request_id, []);
    incEntityMap.get(e.request_id)!.push(e);
  });

  // Categorize bottlenecks
  type Bottleneck = {
    entityName: string;
    entityId: string;
    requestId: string;
    loanNumber: string;
    clientName: string;
    processorName: string;
    processorEmail: string;
    status: string;
    expertName: string | null;
    ageDays: number;
    ageDisplay: string;
    category: 'unassigned' | 'awaiting_signature' | 'irs_queue' | 'stale' | 'no_entities';
  };

  const bottlenecks: Bottleneck[] = [];
  const processorBacklog: Record<string, { name: string; email: string; client: string; pending: number; stale: number }> = {};

  for (const req of (incompleteRequests || [])) {
    const reqEntities = incEntityMap.get(req.id) || [];
    const createdAt = new Date(req.created_at);
    const ageHours = Math.round((now.getTime() - createdAt.getTime()) / (1000 * 60 * 60));
    const ageDays = Math.floor(ageHours / 24);
    const ageDisplay = ageDays > 0 ? `${ageDays}d ${ageHours % 24}h` : `${ageHours}h`;
    const processorName = (req.profiles as any)?.full_name || 'Unknown';
    const processorEmail = (req.profiles as any)?.email || '';
    const processorRole = (req.profiles as any)?.role || '';
    const clientName = (req.clients as any)?.name || 'Unknown';

    // Track processor backlog (skip admin-submitted)
    if (processorRole !== 'admin' && processorEmail) {
      if (!processorBacklog[processorEmail]) {
        processorBacklog[processorEmail] = { name: processorName, email: processorEmail, client: clientName, pending: 0, stale: 0 };
      }
      const pendingCount = reqEntities.filter((e: any) => !['completed', 'failed'].includes(e.status)).length;
      processorBacklog[processorEmail].pending += pendingCount || 1;
      if (ageDays >= 3) processorBacklog[processorEmail].stale += 1;
    }

    // Request with no entities
    if (reqEntities.length === 0) {
      bottlenecks.push({
        entityName: '(No entities)',
        entityId: '',
        requestId: req.id,
        loanNumber: req.loan_number || req.id.slice(0, 8),
        clientName,
        processorName,
        processorEmail,
        status: req.status,
        expertName: null,
        ageDays,
        ageDisplay,
        category: 'no_entities',
      });
      continue;
    }

    for (const entity of reqEntities) {
      if (['completed', 'failed'].includes(entity.status)) continue;
      const assignment = incAssignmentMap.get(entity.id);
      const expertName = assignment?.profiles?.full_name || null;
      const entityAgeHours = Math.round((now.getTime() - new Date(entity.updated_at || entity.created_at).getTime()) / (1000 * 60 * 60));
      const entityAgeDays = Math.floor(entityAgeHours / 24);

      let category: Bottleneck['category'] = 'irs_queue';
      if (entity.status === '8821_sent') category = 'awaiting_signature';
      else if (['irs_queue', 'processing'].includes(entity.status) && !assignment) category = 'unassigned';
      else if (entityAgeDays >= 5) category = 'stale';

      bottlenecks.push({
        entityName: entity.entity_name,
        entityId: entity.id,
        requestId: req.id,
        loanNumber: req.loan_number || req.id.slice(0, 8),
        clientName,
        processorName,
        processorEmail,
        status: entity.status,
        expertName,
        ageDays,
        ageDisplay,
        category,
      });
    }
  }

  // Group by category
  const unassignedBottlenecks = bottlenecks.filter(b => b.category === 'unassigned');
  const signatureBottlenecks = bottlenecks.filter(b => b.category === 'awaiting_signature');
  const staleBottlenecks = bottlenecks.filter(b => b.category === 'stale');
  const irsQueueBottlenecks = bottlenecks.filter(b => b.category === 'irs_queue');
  const noEntityBottlenecks = bottlenecks.filter(b => b.category === 'no_entities');

  // Fetch entities with compliance flags (gross_receipts JSONB contains severity/flags)
  // Include signer_email + requester profile email for marketing outreach
  const { data: allCompletedEntities } = await supabase
    .from('request_entities')
    .select('id, entity_name, status, gross_receipts, request_id, updated_at, signer_email, signer_first_name, signer_last_name, requests(loan_number, requested_by, clients(name), profiles!requests_requested_by_fkey(email, full_name))')
    .eq('status', 'completed')
    .not('gross_receipts', 'is', null) as { data: any[] | null; error: any };

  const complianceFlaggedEntities = (allCompletedEntities || []).filter((e: any) => {
    if (!e.gross_receipts || typeof e.gross_receipts !== 'object') return false;
    return Object.values(e.gross_receipts).some(
      (val: any) => val && typeof val === 'object' && val.severity && ['CRITICAL', 'WARNING'].includes(val.severity)
    );
  }).map((e: any) => {
    const entries = Object.values(e.gross_receipts) as any[];
    const hasCritical = entries.some((v: any) => v?.severity === 'CRITICAL');
    const flagCount = entries.reduce((sum: number, v: any) => sum + (v?.flags?.length || 0), 0);
    // Extract all flags + total exposure for compliance opportunities
    const allFlags: { type: string; message: string; severity: string }[] = [];
    let totalExposure = 0;
    entries.forEach((v: any) => {
      if (v?.flags) allFlags.push(...v.flags);
      if (v?.financials) {
        totalExposure += (v.financials.accountBalance || 0)
          + (v.financials.accruedInterest || 0)
          + (v.financials.accruedPenalty || 0);
      }
    });
    const flagTypes = [...new Set(allFlags.map((f: any) => f.type))];
    // Resolve best contact email: signer_email > requester profile email
    const contactEmail = e.signer_email || e.requests?.profiles?.email || null;
    const contactName = (e.signer_first_name && e.signer_last_name)
      ? `${e.signer_first_name} ${e.signer_last_name}`
      : e.requests?.profiles?.full_name || e.entity_name;
    return { ...e, hasCritical, flagCount, allFlags, totalExposure, flagTypes, contactEmail, contactName };
  }).sort((a: any, b: any) => (a.hasCritical === b.hasCritical ? b.flagCount - a.flagCount : a.hasCritical ? -1 : 1));

  // Compliance Opportunities: group flagged entities by flag type for targeted outreach
  const complianceOpportunities = {
    balanceDue: complianceFlaggedEntities.filter((e: any) => e.flagTypes.includes('BALANCE_DUE')),
    unfiledReturns: complianceFlaggedEntities.filter((e: any) => e.flagTypes.includes('UNFILED')),
    liensLevies: complianceFlaggedEntities.filter((e: any) => e.flagTypes.some((t: string) => ['LIEN', 'LEVY', 'COLLECTION'].includes(t))),
    penalties: complianceFlaggedEntities.filter((e: any) => e.flagTypes.some((t: string) => ['INSTALLMENT', 'OIC'].includes(t))),
    audits: complianceFlaggedEntities.filter((e: any) => e.flagTypes.some((t: string) => ['AUDIT', 'SFR'].includes(t))),
    totalExposure: complianceFlaggedEntities.reduce((sum: number, e: any) => sum + (e.totalExposure || 0), 0),
  };

  // Fetch compliance drip funnel stats
  const { data: dripRecords } = await supabase
    .from('compliance_drip')
    .select('*') as { data: any[] | null; error: any };

  const dripStats = {
    enrolled: (dripRecords || []).length,
    emailsSent: (dripRecords || []).filter((d: any) => d.email_0_sent_at).length,
    opened: (dripRecords || []).filter((d: any) => d.open_count > 0).length,
    clicked: (dripRecords || []).filter((d: any) => d.click_count > 0).length,
    landingVisits: (dripRecords || []).filter((d: any) => d.landing_page_visited_at).length,
    booked: (dripRecords || []).filter((d: any) => d.consultation_booked).length,
    resolved: (dripRecords || []).filter((d: any) => d.resolved).length,
    unsubscribed: (dripRecords || []).filter((d: any) => d.unsubscribed).length,
  };

  // getStuckDuration replaced by bottleneck ageDisplay calculation

  // Calculate stats per client — count at entity (EIN/SSN) level, not request level
  const clientStats: Record<
    string,
    {
      name: string;
      total: number;
      pending: number;
      completed: number;
      failed: number;
      api_key: string | null;
      api_request_limit: number | null;
      employment_count: number;
    }
  > = {};

  if (!clientsError && clients) {
    clients.forEach((client) => {
      clientStats[client.id] = {
        name: client.name,
        total: 0,
        pending: 0,
        completed: 0,
        failed: 0,
        api_key: client.api_key,
        api_request_limit: client.api_request_limit,
        employment_count: 0,
      };
    });
  }

  if (!requestsError && allRequests) {
    allRequests.forEach((request: any) => {
      if (clientStats[request.client_id]) {
        const entities = request.request_entities || [];
        // Count each entity (EIN/SSN) individually
        entities.forEach((entity: any) => {
          clientStats[request.client_id].total += 1;
          if (entity.status === 'completed') {
            clientStats[request.client_id].completed += 1;
          } else if (entity.status === 'failed') {
            clientStats[request.client_id].failed += 1;
          } else {
            clientStats[request.client_id].pending += 1;
          }
        });

        if (request.product_type === 'employment') {
          clientStats[request.client_id].employment_count += 1;
        }
      }
    });
  }

  // Filter requests by product type, search, status, time window, and legacy flag.
  // Order: start from `allRequests` (already sorted by updated_at DESC), layer on filters.
  let filteredRequests = allRequests || [];
  if (productTypeFilter && productTypeFilter !== 'all') {
    filteredRequests = filteredRequests.filter((r: any) => r.product_type === productTypeFilter);
  }
  if (searchFilter) {
    const searchLower = searchFilter.toLowerCase();
    filteredRequests = filteredRequests.filter((r: any) => {
      // Search by loan number
      if (r.loan_number?.toLowerCase().includes(searchLower)) return true;
      // Search by client name
      if (r.clients?.name?.toLowerCase().includes(searchLower)) return true;
      // Search by entity name (borrower / taxpayer name)
      const entities = r.request_entities || [];
      if (entities.some((e: any) => e.entity_name?.toLowerCase().includes(searchLower))) return true;
      return false;
    });
  }
  if (statusFilter && statusFilter !== 'all') {
    filteredRequests = filteredRequests.filter((r: any) => r.status === statusFilter);
  }
  // Hide migration-imported requests by default — they're long-historical and clog the list.
  // Triggered off the `HIST-` loan-number convention used by the Dropbox backfill.
  if (hideLegacy && !searchFilter) {
    filteredRequests = filteredRequests.filter((r: any) => !r.loan_number?.startsWith('HIST-'));
  }
  // Time window — default 7d. Applies to updated_at so real-time activity bubbles to the top.
  // A search term bypasses the window filter (user is explicitly looking for something old).
  if (windowDays !== null && !searchFilter) {
    const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
    filteredRequests = filteredRequests.filter((r: any) => {
      const ts = new Date(r.updated_at || r.created_at).getTime();
      return ts >= cutoff;
    });
  }

  // Paginate the final filtered list.
  const totalFiltered = filteredRequests.length;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / ADMIN_REQUESTS_PAGE_SIZE));
  const pageIndex = Math.min(currentPage, totalPages - 1);
  const visibleRequests = filteredRequests.slice(
    pageIndex * ADMIN_REQUESTS_PAGE_SIZE,
    (pageIndex + 1) * ADMIN_REQUESTS_PAGE_SIZE,
  );

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
    const statusLabels: Record<string, string> = {
      'irs_queue': 'IRS Queue',
      '8821_sent': '8821 Sent',
      '8821_signed': '8821 Signed',
    };
    if (statusLabels[status]) return statusLabels[status];
    return status
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  // Count total stats at entity level
  const allEntities = allRequests?.flatMap((r: any) => r.request_entities || []) || [];
  const totalStats = {
    total: allEntities.length,
    completed: allEntities.filter((e: any) => e.status === 'completed').length,
    pending: allEntities.filter((e: any) => e.status !== 'completed' && e.status !== 'failed').length,
    failed: allEntities.filter((e: any) => e.status === 'failed').length,
  };

  // --- Billing & Revenue Calculations ---
  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);

  // Current month (April) + Previous month (March)
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const currentMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
  // prev/current month labels — retained for potential future use by the
  // per-client rows; no longer headline display.
  void prevMonthStart; void currentMonthStart;

  // Per-client revenue: current month + previous month + all-time
  const clientRevenueCurrent: Record<string, number> = {};
  const clientRevenueEntitiesCurrent: Record<string, number> = {};
  const clientRevenuePrev: Record<string, number> = {};
  const clientRevenueEntitiesPrev: Record<string, number> = {};
  const clientRevenueAllTime: Record<string, number> = {};
  const clientRevenueEntitiesAllTime: Record<string, number> = {};
  (clients || []).forEach((c) => {
    clientRevenueCurrent[c.id] = 0; clientRevenueEntitiesCurrent[c.id] = 0;
    clientRevenuePrev[c.id] = 0; clientRevenueEntitiesPrev[c.id] = 0;
    clientRevenueAllTime[c.id] = 0; clientRevenueEntitiesAllTime[c.id] = 0;
  });

  // Build free trial sets (first 3 completed entities per client)
  const freeTrialSets: Record<string, Set<string>> = {};
  (clients || []).forEach((c) => {
    if (c.free_trial) {
      const sorted = (allRequests || [])
        .filter((r: any) => r.client_id === c.id)
        .flatMap((r: any) => (r.request_entities || []).filter((e: any) => e.status === 'completed' && e.completed_at))
        .sort((a: any, b: any) => new Date(a.completed_at).getTime() - new Date(b.completed_at).getTime());
      freeTrialSets[c.id] = new Set(sorted.slice(0, 3).map((e: any) => e.id));
    } else {
      freeTrialSets[c.id] = new Set();
    }
  });

  (allRequests || []).forEach((req: any) => {
    const clientId = req.client_id;
    if (!clientRevenueCurrent.hasOwnProperty(clientId)) return;
    const clientObj = (clients || []).find((c) => c.id === clientId);
    if (!clientObj) return;

    (req.request_entities || []).forEach((entity: any) => {
      if (entity.status !== 'completed' || !entity.completed_at) return;
      if (freeTrialSets[clientId]?.has(entity.id)) return;

      const completedDate = new Date(entity.completed_at);
      const rate = req.intake_method === 'csv' ? (clientObj.billing_rate_csv || 69.98) : (clientObj.billing_rate_pdf || 59.98);

      // All-time
      clientRevenueAllTime[clientId] += rate;
      clientRevenueEntitiesAllTime[clientId] += 1;

      // Current month
      if (completedDate >= currentMonthStart && completedDate <= currentMonthEnd) {
        clientRevenueCurrent[clientId] += rate;
        clientRevenueEntitiesCurrent[clientId] += 1;
      }

      // Previous month
      if (completedDate >= prevMonthStart && completedDate <= prevMonthEnd) {
        clientRevenuePrev[clientId] += rate;
        clientRevenueEntitiesPrev[clientId] += 1;
      }
    });
  });

  // NOTE: Headline revenue + AR totals moved to computeRevenueMetrics()
  // (Mercury-synced source of truth). Keep clientRevenuePrev/Current for the
  // per-client breakdown row tooltip below.

  return (
    <div className="min-h-screen bg-gray-50">
      {/* SOC 2 Data Classification Banner */}
      <div className={`border-b px-4 py-2 text-center text-xs font-semibold tracking-wide ${getClassificationColor('internal')}`}>
        🔒 {getClassificationLabel('internal')}
      </div>

      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold text-mt-dark">Admin Dashboard</h1>
              <p className="text-gray-600 text-sm mt-1">Cross-client overview and management</p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {/* Fires every pending Dropbox Sign 8821 request across all clients.
                  Live count refreshes on mount and after each send. Two-step
                  confirm prevents accidental bulk spend. */}
              <FireAllPending8821sButton />
              <Link
                href="/admin/billing"
                className="px-3 py-1.5 text-xs sm:text-sm font-medium text-white bg-mt-green rounded-lg hover:bg-mt-green/90 transition-colors"
              >
                Billing
              </Link>
              <Link
                href="/admin/clearfirm-bot"
                className="px-3 py-1.5 text-xs sm:text-sm font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 transition-colors"
              >
                Clearfirm Bot
              </Link>
              <details className="relative group">
                <summary className="list-none cursor-pointer px-3 py-1.5 text-xs sm:text-sm font-medium text-mt-dark border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors flex items-center gap-1">
                  More
                  <svg className="w-3 h-3 transition-transform group-open:rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </summary>
                <div className="absolute right-0 mt-2 w-52 bg-white border border-gray-200 rounded-lg shadow-lg z-20 py-1">
                  <Link href="/admin/email-intake" className="block px-4 py-2 text-sm text-mt-dark hover:bg-gray-50">Email Intake</Link>
                  <Link href="/admin/analytics" className="block px-4 py-2 text-sm text-mt-dark hover:bg-gray-50">Analytics</Link>
                  <Link href="/admin/email-engagement" className="block px-4 py-2 text-sm text-mt-dark hover:bg-gray-50">Email engagement</Link>
                  <Link href="/admin/experts" className="block px-4 py-2 text-sm text-mt-dark hover:bg-gray-50">IRS Experts</Link>
                  <Link href="/admin/team" className="block px-4 py-2 text-sm text-mt-dark hover:bg-gray-50">Team</Link>
                  <Link href="/admin/payroll" className="block px-4 py-2 text-sm text-mt-dark hover:bg-gray-50">Payroll</Link>
                  <Link
                    href="/admin/pending-signups"
                    className="block px-4 py-2 text-sm text-amber-800 bg-amber-50 hover:bg-amber-100"
                    title="Sign-ups awaiting admin approval"
                  >
                    Pending Signups
                  </Link>
                  <div className="border-t border-gray-100 my-1" />
                  <Link href="/" className="block px-4 py-2 text-sm text-gray-500 hover:bg-gray-50">← Main Dashboard</Link>
                </div>
              </details>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        {/* ===== ACTION RIBBON — what needs attention right now =====
            Replaces the old 4 entity-count cards + 5 revenue KPI cards.
            Each tile is a clickable anchor jumping to the relevant
            section below (or another admin page). Counts come from
            existing variables — no extra queries. */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 sm:gap-3 mb-6">
          {/* Q2 progress — first tile, links to Billing detail */}
          <Link href="/admin/billing" className="bg-white rounded-lg border border-gray-200 p-3 hover:border-mt-green hover:shadow-sm transition-all">
            <p className="text-[11px] uppercase tracking-wide text-gray-500 font-medium">{revenueMetrics.quarter_label}</p>
            <p className="text-lg font-bold text-mt-dark mt-0.5">{q2ProgressPct.toFixed(1)}%</p>
            <p className="text-[11px] text-gray-500">{formatDollars(revenueMetrics.totals.projected_q2)} / {formatDollars(revenueMetrics.q2_target_dollars)}</p>
          </Link>
          {/* Open AR */}
          <a href="#revenue-detail" className={`rounded-lg border p-3 hover:shadow-sm transition-all ${revenueMetrics.totals.open_ar_q2 > 0 ? 'bg-amber-50 border-amber-200' : 'bg-white border-gray-200'}`}>
            <p className="text-[11px] uppercase tracking-wide text-gray-500 font-medium">Open AR</p>
            <p className={`text-lg font-bold mt-0.5 ${revenueMetrics.totals.open_ar_q2 > 0 ? 'text-amber-700' : 'text-gray-400'}`}>{formatDollars(revenueMetrics.totals.open_ar_q2)}</p>
            <p className="text-[11px] text-gray-500">{revenueMetrics.ar_aging.rows.length} invoice{revenueMetrics.ar_aging.rows.length !== 1 ? 's' : ''}</p>
          </a>
          {/* Overdue 15+ days — red if > 0 */}
          {(() => {
            const overdueAmt = revenueMetrics.ar_aging.overdue_15_30.amount + revenueMetrics.ar_aging.overdue_30_plus.amount;
            const overdueCount = revenueMetrics.ar_aging.overdue_15_30.invoice_count + revenueMetrics.ar_aging.overdue_30_plus.invoice_count;
            return (
              <a href="#revenue-detail" className={`rounded-lg border p-3 hover:shadow-sm transition-all ${overdueAmt > 0 ? 'bg-red-50 border-red-300' : 'bg-white border-gray-200'}`}>
                <p className="text-[11px] uppercase tracking-wide text-gray-500 font-medium">Overdue 15d+</p>
                <p className={`text-lg font-bold mt-0.5 ${overdueAmt > 0 ? 'text-red-700' : 'text-gray-400'}`}>{formatDollars(overdueAmt)}</p>
                <p className="text-[11px] text-gray-500">{overdueCount} late</p>
              </a>
            );
          })()}
          {/* Bottlenecks — count of items needing attention */}
          <a href="#bottlenecks" className={`rounded-lg border p-3 hover:shadow-sm transition-all ${bottlenecks.length > 0 ? 'bg-red-50 border-red-300' : 'bg-white border-gray-200'}`}>
            <p className="text-[11px] uppercase tracking-wide text-gray-500 font-medium">Blocking</p>
            <p className={`text-lg font-bold mt-0.5 ${bottlenecks.length > 0 ? 'text-red-700' : 'text-gray-400'}`}>{bottlenecks.length}</p>
            <p className="text-[11px] text-gray-500">{staleBottlenecks.length} stale · {unassignedBottlenecks.length} unassigned</p>
          </a>
          {/* Pending entities — neutral */}
          <a href="#all-requests" className="bg-white rounded-lg border border-gray-200 p-3 hover:border-mt-green hover:shadow-sm transition-all">
            <p className="text-[11px] uppercase tracking-wide text-gray-500 font-medium">Pending</p>
            <p className="text-lg font-bold text-yellow-600 mt-0.5">{totalStats.pending}</p>
            <p className="text-[11px] text-gray-500">of {totalStats.total} total</p>
          </a>
          {/* Failed entities */}
          <a href="#all-requests" className={`rounded-lg border p-3 hover:shadow-sm transition-all ${totalStats.failed > 0 ? 'bg-red-50 border-red-200' : 'bg-white border-gray-200'}`}>
            <p className="text-[11px] uppercase tracking-wide text-gray-500 font-medium">Failed</p>
            <p className={`text-lg font-bold mt-0.5 ${totalStats.failed > 0 ? 'text-red-700' : 'text-gray-400'}`}>{totalStats.failed}</p>
            <p className="text-[11px] text-gray-500">{totalStats.completed} completed</p>
          </a>
        </div>

        {/* ===== REVENUE & Q2 PROGRESS — collapsed by default. The action
            ribbon above already shows the 1-line summary; this <details>
            holds the full breakdown for when you want to drill in. ===== */}
        <details id="revenue-detail" className="mb-6 group">
          <summary className="list-none cursor-pointer flex items-center justify-between bg-white rounded-lg shadow px-5 py-3 border border-gray-200 hover:border-mt-green/40 transition-colors">
            <div className="flex items-baseline gap-3 flex-wrap">
              <span className="text-base font-bold text-mt-dark">Revenue & AR detail</span>
              <span className="text-xs text-gray-500">
                {revenueMetrics.quarter_label} paid {formatDollars(revenueMetrics.totals.paid_q2)} ·
                YTD {formatDollars(revenueMetrics.totals.paid_ytd)} ·
                All-time {formatDollars(revenueMetrics.totals.paid_all_time)} ·
                Gap to target {formatDollars(q2GapDollars)}
              </span>
            </div>
            <svg className="w-4 h-4 text-gray-400 transition-transform group-open:rotate-180 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </summary>
          <div className="mt-4">
          {/* Q2 Progress Bar */}
          <div className="bg-white rounded-lg shadow p-5 sm:p-6 mb-6 border border-mt-green/20">
            <div className="flex flex-wrap items-baseline justify-between mb-3 gap-2">
              <h2 className="text-lg sm:text-xl font-bold text-mt-dark">
                {revenueMetrics.quarter_label} Revenue Target
              </h2>
              <div className="text-right">
                <p className="text-xs text-gray-500 uppercase tracking-wide">Target</p>
                <p className="text-xl font-bold text-mt-dark">{formatDollars(revenueMetrics.q2_target_dollars)}</p>
              </div>
            </div>
            <div className="relative h-6 bg-gray-100 rounded-full overflow-hidden mb-3">
              <div
                className="absolute inset-y-0 left-0 bg-gradient-to-r from-mt-green to-emerald-400 rounded-full transition-all duration-500"
                style={{ width: `${q2ProgressPct}%` }}
              />
              <div className="absolute inset-0 flex items-center justify-center text-xs font-semibold text-mt-dark">
                {q2ProgressPct.toFixed(1)}% · {formatDollars(revenueMetrics.totals.projected_q2)} booked
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <div>
                <p className="text-xs text-gray-500">Q2 paid</p>
                <p className="font-semibold text-emerald-600">{formatDollars(revenueMetrics.totals.paid_q2)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Q2 open AR</p>
                <p className="font-semibold text-amber-600">{formatDollars(revenueMetrics.totals.open_ar_q2)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Subscription baseline</p>
                <p className="font-semibold text-blue-600">
                  {formatDollars(revenueMetrics.totals.projected_q2 - revenueMetrics.totals.booked_q2)}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Gap to target</p>
                <p className="font-semibold text-red-600">{formatDollars(q2GapDollars)}</p>
              </div>
            </div>
          </div>

          {/* KPI Cards removed — same numbers now live in the action
              ribbon at the top of the page (Open AR, Overdue 15d+) and in
              the summary line of this <details> (Q2 paid, YTD, all-time).
              Eliminating the 5-card row was the highest-leverage cleanup
              for clutter — no information loss. */}

          {/* Per-Client Billing Table */}
          <div className="bg-white rounded-lg shadow overflow-hidden mb-6">
            <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
              <h3 className="text-base sm:text-lg font-bold text-mt-dark">Revenue by Client</h3>
              <span className="text-xs text-gray-500">Synced from Mercury · {revenueMetrics.today_iso}</span>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-xs uppercase text-gray-600">
                  <tr>
                    <th className="px-4 py-2 text-left font-semibold">Client</th>
                    <th className="px-4 py-2 text-left font-semibold">Model</th>
                    <th className="px-4 py-2 text-right font-semibold">All-Time Paid</th>
                    <th className="px-4 py-2 text-right font-semibold">YTD Paid</th>
                    <th className="px-4 py-2 text-right font-semibold">Q2 Paid</th>
                    <th className="px-4 py-2 text-right font-semibold">Open AR</th>
                    <th className="px-4 py-2 text-center font-semibold">MTD Usage</th>
                    <th className="px-4 py-2 text-left font-semibold">Last Payment</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {revenueMetrics.client_rows.length === 0 ? (
                    <tr><td colSpan={8} className="px-4 py-6 text-center text-gray-500">No client revenue yet.</td></tr>
                  ) : revenueMetrics.client_rows.map(row => (
                    <tr key={row.client_id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium text-mt-dark">
                        {row.client_name}
                        {row.pending_signature && (
                          <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-200 text-gray-700">pending sig</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {row.billing_model === 'subscription' ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">
                            Sub · {formatDollars(row.subscription_monthly_amount || 0)}/mo
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-800">
                            PAYG
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-mt-dark">{formatDollars(row.paid_all_time)}</td>
                      <td className="px-4 py-3 text-right font-mono">{formatDollars(row.paid_ytd)}</td>
                      <td className="px-4 py-3 text-right font-mono text-emerald-600">{formatDollars(row.paid_q2)}</td>
                      <td className={`px-4 py-3 text-right font-mono ${row.open_ar > 0 ? 'text-amber-600' : 'text-gray-400'}`}>
                        {row.open_ar > 0 ? formatDollars(row.open_ar) : '—'}
                      </td>
                      <td className="px-4 py-3 text-center text-gray-700">
                        {row.billing_model === 'subscription' && row.subscription_included ? (
                          <span className={row.entities_mtd > row.subscription_included ? 'text-red-600 font-semibold' : ''}>
                            {row.entities_mtd}/{row.subscription_included}
                          </span>
                        ) : (
                          row.entities_mtd || '—'
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-600">
                        {row.last_paid_at ? (
                          <>
                            {new Date(row.last_paid_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                            <span className="text-gray-400"> · {formatDollars(row.last_paid_amount || 0)}</span>
                          </>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* AR Aging */}
          {revenueMetrics.ar_aging.rows.length > 0 && (
            <div className="bg-white rounded-lg shadow overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-200">
                <h3 className="text-base sm:text-lg font-bold text-mt-dark">Open AR Aging</h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3 text-xs">
                  <div className="bg-emerald-50 rounded px-3 py-2">
                    <p className="text-gray-600">Current (≤14 days)</p>
                    <p className="font-bold text-emerald-700">{formatDollars(revenueMetrics.ar_aging.current.amount)} · {revenueMetrics.ar_aging.current.invoice_count}</p>
                  </div>
                  <div className="bg-amber-50 rounded px-3 py-2">
                    <p className="text-gray-600">15-30 days late</p>
                    <p className="font-bold text-amber-700">{formatDollars(revenueMetrics.ar_aging.overdue_15_30.amount)} · {revenueMetrics.ar_aging.overdue_15_30.invoice_count}</p>
                  </div>
                  <div className="bg-red-50 rounded px-3 py-2">
                    <p className="text-gray-600">30+ days late</p>
                    <p className="font-bold text-red-700">{formatDollars(revenueMetrics.ar_aging.overdue_30_plus.amount)} · {revenueMetrics.ar_aging.overdue_30_plus.invoice_count}</p>
                  </div>
                  <div className="bg-gray-100 rounded px-3 py-2">
                    <p className="text-gray-600">Pending signature</p>
                    <p className="font-bold text-gray-700">{formatDollars(revenueMetrics.ar_aging.pending_signature.amount)} · {revenueMetrics.ar_aging.pending_signature.invoice_count}</p>
                  </div>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 text-xs uppercase text-gray-600">
                    <tr>
                      <th className="px-4 py-2 text-left font-semibold">Invoice</th>
                      <th className="px-4 py-2 text-left font-semibold">Client</th>
                      <th className="px-4 py-2 text-right font-semibold">Amount</th>
                      <th className="px-4 py-2 text-left font-semibold">Due</th>
                      <th className="px-4 py-2 text-right font-semibold">Days</th>
                      <th className="px-4 py-2 text-left font-semibold">Bucket</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {revenueMetrics.ar_aging.rows.map(row => (
                      <tr key={row.invoice_id} className="hover:bg-gray-50">
                        <td className="px-4 py-2 font-mono text-xs">{row.invoice_number}</td>
                        <td className="px-4 py-2">{row.client_name}</td>
                        <td className="px-4 py-2 text-right font-mono">{formatDollars(row.amount)}</td>
                        <td className="px-4 py-2 text-xs text-gray-600">{row.due_date || '—'}</td>
                        <td className={`px-4 py-2 text-right text-xs ${row.days_overdue > 30 ? 'text-red-600 font-semibold' : row.days_overdue > 14 ? 'text-amber-600' : 'text-gray-600'}`}>
                          {row.days_overdue > 0 ? `+${row.days_overdue}` : row.days_overdue}
                        </td>
                        <td className="px-4 py-2 text-xs">
                          {row.bucket === 'pending_signature' ? (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-200 text-gray-700">pending sig</span>
                          ) : row.bucket === 'overdue_30_plus' ? (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">30+ late</span>
                          ) : row.bucket === 'overdue_15_30' ? (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700">15-30 late</span>
                          ) : (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-700">current</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          </div>
        </details>

        {/* Bottleneck Resolution Center — anchor target from action ribbon */}
        {bottlenecks.length > 0 && (
          <div id="bottlenecks" className="mb-8 sm:mb-12 space-y-4 scroll-mt-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
                <h2 className="text-xl font-bold text-gray-900">Bottleneck Resolution</h2>
                <span className="px-2 py-0.5 bg-red-100 text-red-800 text-xs font-bold rounded-full">
                  {bottlenecks.length} blocking
                </span>
              </div>
            </div>

            {/* Bottleneck Summary Cards */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <div className={`rounded-lg p-4 border ${unassignedBottlenecks.length > 0 ? 'bg-red-50 border-red-200' : 'bg-gray-50 border-gray-200'}`}>
                <div className={`text-2xl font-bold ${unassignedBottlenecks.length > 0 ? 'text-red-700' : 'text-gray-400'}`}>{unassignedBottlenecks.length}</div>
                <div className="text-xs font-medium text-gray-600 mt-1">Unassigned</div>
                <div className="text-[10px] text-gray-400">Need expert</div>
              </div>
              <div className={`rounded-lg p-4 border ${signatureBottlenecks.length > 0 ? 'bg-blue-50 border-blue-200' : 'bg-gray-50 border-gray-200'}`}>
                <div className={`text-2xl font-bold ${signatureBottlenecks.length > 0 ? 'text-blue-700' : 'text-gray-400'}`}>{signatureBottlenecks.length}</div>
                <div className="text-xs font-medium text-gray-600 mt-1">Awaiting 8821</div>
                <div className="text-[10px] text-gray-400">Needs signature</div>
              </div>
              <div className={`rounded-lg p-4 border ${irsQueueBottlenecks.length > 0 ? 'bg-amber-50 border-amber-200' : 'bg-gray-50 border-gray-200'}`}>
                <div className={`text-2xl font-bold ${irsQueueBottlenecks.length > 0 ? 'text-amber-700' : 'text-gray-400'}`}>{irsQueueBottlenecks.length}</div>
                <div className="text-xs font-medium text-gray-600 mt-1">IRS Queue</div>
                <div className="text-[10px] text-gray-400">Expert working</div>
              </div>
              <div className={`rounded-lg p-4 border ${staleBottlenecks.length > 0 ? 'bg-red-50 border-red-300' : 'bg-gray-50 border-gray-200'}`}>
                <div className={`text-2xl font-bold ${staleBottlenecks.length > 0 ? 'text-red-700' : 'text-gray-400'}`}>{staleBottlenecks.length}</div>
                <div className="text-xs font-medium text-gray-600 mt-1">Stale (5d+)</div>
                <div className="text-[10px] text-gray-400">Needs escalation</div>
              </div>
              <div className={`rounded-lg p-4 border ${noEntityBottlenecks.length > 0 ? 'bg-purple-50 border-purple-200' : 'bg-gray-50 border-gray-200'}`}>
                <div className={`text-2xl font-bold ${noEntityBottlenecks.length > 0 ? 'text-purple-700' : 'text-gray-400'}`}>{noEntityBottlenecks.length}</div>
                <div className="text-xs font-medium text-gray-600 mt-1">No Entities</div>
                <div className="text-[10px] text-gray-400">Empty request</div>
              </div>
            </div>

            {/* Unassigned — highest priority */}
            {unassignedBottlenecks.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <h3 className="text-sm font-bold text-red-800 mb-3 flex items-center gap-2">
                  <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse"></span>
                  Needs Expert Assignment ({unassignedBottlenecks.length})
                </h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-red-200">
                        <th className="px-3 py-2 text-left font-semibold text-red-900 text-xs">Entity</th>
                        <th className="px-3 py-2 text-left font-semibold text-red-900 text-xs">Client</th>
                        <th className="px-3 py-2 text-left font-semibold text-red-900 text-xs">Processor</th>
                        <th className="px-3 py-2 text-left font-semibold text-red-900 text-xs">Age</th>
                        <th className="px-3 py-2 text-left font-semibold text-red-900 text-xs">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-red-100">
                      {unassignedBottlenecks.map((b, i) => (
                        <tr key={`unassigned-${i}`}>
                          <td className="px-3 py-2 font-medium text-red-900">{b.entityName}</td>
                          <td className="px-3 py-2 text-red-800 text-xs">{b.clientName}</td>
                          <td className="px-3 py-2 text-red-800 text-xs">{b.processorName}</td>
                          <td className="px-3 py-2">
                            <span className={`font-mono text-xs font-bold ${b.ageDays >= 3 ? 'text-red-700' : 'text-amber-700'}`}>{b.ageDisplay}</span>
                          </td>
                          <td className="px-3 py-2">
                            <Link href={`/admin/requests/${b.requestId}`} className="text-red-700 hover:text-red-900 underline font-medium text-xs">
                              Assign Expert
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Awaiting 8821 Signature */}
            {signatureBottlenecks.length > 0 && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <h3 className="text-sm font-bold text-blue-800 mb-3">
                  Awaiting 8821 Signature ({signatureBottlenecks.length})
                </h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-blue-200">
                        <th className="px-3 py-2 text-left font-semibold text-blue-900 text-xs">Entity</th>
                        <th className="px-3 py-2 text-left font-semibold text-blue-900 text-xs">Client</th>
                        <th className="px-3 py-2 text-left font-semibold text-blue-900 text-xs">Processor</th>
                        <th className="px-3 py-2 text-left font-semibold text-blue-900 text-xs">Waiting</th>
                        <th className="px-3 py-2 text-left font-semibold text-blue-900 text-xs">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-blue-100">
                      {signatureBottlenecks.map((b, i) => (
                        <tr key={`sig-${i}`}>
                          <td className="px-3 py-2 font-medium text-blue-900">{b.entityName}</td>
                          <td className="px-3 py-2 text-blue-800 text-xs">{b.clientName}</td>
                          <td className="px-3 py-2 text-blue-800 text-xs">{b.processorName}</td>
                          <td className="px-3 py-2">
                            <span className={`font-mono text-xs font-bold ${b.ageDays >= 7 ? 'text-red-700' : b.ageDays >= 3 ? 'text-amber-700' : 'text-blue-700'}`}>{b.ageDisplay}</span>
                          </td>
                          <td className="px-3 py-2">
                            <Link href={`/admin/requests/${b.requestId}`} className="text-blue-700 hover:text-blue-900 underline font-medium text-xs">
                              Resend 8821
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* IRS Queue — in progress */}
            {irsQueueBottlenecks.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                <h3 className="text-sm font-bold text-amber-800 mb-3">
                  In IRS Queue ({irsQueueBottlenecks.length})
                </h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-amber-200">
                        <th className="px-3 py-2 text-left font-semibold text-amber-900 text-xs">Entity</th>
                        <th className="px-3 py-2 text-left font-semibold text-amber-900 text-xs">Client</th>
                        <th className="px-3 py-2 text-left font-semibold text-amber-900 text-xs">Expert</th>
                        <th className="px-3 py-2 text-left font-semibold text-amber-900 text-xs">Age</th>
                        <th className="px-3 py-2 text-left font-semibold text-amber-900 text-xs">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-amber-100">
                      {irsQueueBottlenecks.map((b, i) => (
                        <tr key={`irs-${i}`}>
                          <td className="px-3 py-2 font-medium text-amber-900">{b.entityName}</td>
                          <td className="px-3 py-2 text-amber-800 text-xs">{b.clientName}</td>
                          <td className="px-3 py-2 text-amber-800 text-xs">{b.expertName || (<span className="text-red-600 font-bold">Unassigned</span>)}</td>
                          <td className="px-3 py-2">
                            <span className={`font-mono text-xs font-bold ${b.ageDays >= 3 ? 'text-red-700' : 'text-amber-700'}`}>{b.ageDisplay}</span>
                          </td>
                          <td className="px-3 py-2">
                            <Link href={`/admin/requests/${b.requestId}`} className="text-amber-700 hover:text-amber-900 underline font-medium text-xs">
                              View
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Stale entities */}
            {staleBottlenecks.length > 0 && (
              <div className="bg-red-50 border border-red-300 rounded-lg p-4">
                <h3 className="text-sm font-bold text-red-800 mb-3">
                  Stale — Needs Escalation ({staleBottlenecks.length})
                </h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-red-200">
                        <th className="px-3 py-2 text-left font-semibold text-red-900 text-xs">Entity</th>
                        <th className="px-3 py-2 text-left font-semibold text-red-900 text-xs">Client</th>
                        <th className="px-3 py-2 text-left font-semibold text-red-900 text-xs">Status</th>
                        <th className="px-3 py-2 text-left font-semibold text-red-900 text-xs">Expert</th>
                        <th className="px-3 py-2 text-left font-semibold text-red-900 text-xs">Stuck For</th>
                        <th className="px-3 py-2 text-left font-semibold text-red-900 text-xs">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-red-100">
                      {staleBottlenecks.map((b, i) => (
                        <tr key={`stale-${i}`}>
                          <td className="px-3 py-2 font-medium text-red-900">{b.entityName}</td>
                          <td className="px-3 py-2 text-red-800 text-xs">{b.clientName}</td>
                          <td className="px-3 py-2">
                            <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${getStatusBadgeColor(b.status)}`}>
                              {formatStatus(b.status)}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-red-800 text-xs">{b.expertName || '—'}</td>
                          <td className="px-3 py-2">
                            <span className="font-mono text-xs font-bold text-red-700">{b.ageDisplay}</span>
                          </td>
                          <td className="px-3 py-2">
                            <Link href={`/admin/requests/${b.requestId}`} className="text-red-700 hover:text-red-900 underline font-medium text-xs">
                              Escalate
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Processor Backlog Summary */}
            {Object.keys(processorBacklog).length > 0 && (
              <div className="bg-white border border-gray-200 rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-bold text-gray-800">Processor Backlog</h3>
                  <NotifyProcessorsButton />
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-200">
                        <th className="px-3 py-2 text-left font-semibold text-gray-700 text-xs">Processor</th>
                        <th className="px-3 py-2 text-left font-semibold text-gray-700 text-xs">Client</th>
                        <th className="px-3 py-2 text-center font-semibold text-gray-700 text-xs">Pending</th>
                        <th className="px-3 py-2 text-center font-semibold text-gray-700 text-xs">Stale</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {Object.values(processorBacklog).sort((a, b) => b.stale - a.stale || b.pending - a.pending).map((p, i) => (
                        <tr key={`proc-${i}`}>
                          <td className="px-3 py-2">
                            <div className="font-medium text-gray-900 text-sm">{p.name}</div>
                            <div className="text-xs text-gray-400">{p.email}</div>
                          </td>
                          <td className="px-3 py-2 text-gray-600 text-xs">{p.client}</td>
                          <td className="px-3 py-2 text-center">
                            <span className="font-bold text-amber-700">{p.pending}</span>
                          </td>
                          <td className="px-3 py-2 text-center">
                            {p.stale > 0 ? (
                              <span className="px-2 py-0.5 bg-red-100 text-red-700 text-xs font-bold rounded-full">{p.stale}</span>
                            ) : (
                              <span className="text-green-600 text-xs">0</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Compliance Marketing Funnel — collapsed by default */}
        {complianceFlaggedEntities.length > 0 && (
          <details className="mb-8 group">
            <summary className="list-none cursor-pointer flex items-center justify-between bg-white rounded-lg shadow px-5 py-3 border border-gray-200 hover:border-mt-green/40 transition-colors">
              <div className="flex items-baseline gap-3 flex-wrap">
                <span className="text-base font-bold text-mt-dark">
                  Compliance Marketing
                </span>
                <span className="text-xs text-gray-500">
                  {complianceFlaggedEntities.length} flagged ·
                  {' '}{complianceFlaggedEntities.filter((e: any) => e.hasCritical).length} critical ·
                  {' '}{dripStats.enrolled} enrolled · {dripStats.clicked} clicked · {dripStats.booked} booked
                </span>
              </div>
              <svg className="w-4 h-4 text-gray-400 transition-transform group-open:rotate-180 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </summary>
          <div className="mt-4 space-y-6">
            {/* Funnel Stats */}
            <div className="bg-gradient-to-r from-red-50 to-amber-50 border border-red-200 rounded-lg p-6">
              <div className="flex items-center gap-2 mb-4">
                <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
                <h3 className="text-lg font-bold text-red-800">
                  Compliance Marketing ({complianceFlaggedEntities.length} flagged entit{complianceFlaggedEntities.length === 1 ? 'y' : 'ies'})
                </h3>
                <span className="ml-2 px-2 py-0.5 bg-red-200 text-red-900 text-xs font-bold rounded-full">
                  {complianceFlaggedEntities.filter((e: any) => e.hasCritical).length} Critical
                </span>
                <span className="ml-1 px-2 py-0.5 bg-green-100 text-green-800 text-xs font-bold rounded-full">
                  {complianceFlaggedEntities.filter((e: any) => e.contactEmail).length} with email
                </span>
                {complianceFlaggedEntities.filter((e: any) => !e.contactEmail).length > 0 && (
                  <span className="ml-1 px-2 py-0.5 bg-yellow-100 text-yellow-800 text-xs font-bold rounded-full">
                    {complianceFlaggedEntities.filter((e: any) => !e.contactEmail).length} missing email
                  </span>
                )}
              </div>

              {/* Conversion Funnel */}
              <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-7 gap-2 mb-4">
                {[
                  { label: 'Flagged', value: complianceFlaggedEntities.length, color: 'bg-red-100 text-red-800 border-red-200' },
                  { label: 'Enrolled', value: dripStats.enrolled, color: 'bg-red-100 text-red-700 border-red-200' },
                  { label: 'Emailed', value: dripStats.emailsSent, color: 'bg-amber-100 text-amber-800 border-amber-200' },
                  { label: 'Opened', value: dripStats.opened, color: 'bg-amber-100 text-amber-700 border-amber-200' },
                  { label: 'Clicked', value: dripStats.clicked, color: 'bg-yellow-100 text-yellow-800 border-yellow-200' },
                  { label: 'Page Visit', value: dripStats.landingVisits, color: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
                  { label: 'Booked', value: dripStats.booked, color: 'bg-emerald-200 text-emerald-900 border-emerald-300' },
                ].map((step, i) => (
                  <div key={i} className={`${step.color} border rounded-lg p-3 text-center`}>
                    <div className="text-2xl font-bold">{step.value}</div>
                    <div className="text-xs font-medium mt-1">{step.label}</div>
                  </div>
                ))}
              </div>

              {dripStats.unsubscribed > 0 && (
                <p className="text-xs text-red-600">{dripStats.unsubscribed} unsubscribed</p>
              )}
            </div>

            {/* Entity Table */}
            <div className="bg-white border border-gray-200 rounded-lg p-6">
              <h4 className="text-sm font-semibold text-gray-700 mb-3">Flagged Entities</h4>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200">
                      <th className="px-4 py-2 text-left font-semibold text-gray-700">Entity</th>
                      <th className="px-4 py-2 text-left font-semibold text-gray-700">Client</th>
                      <th className="px-4 py-2 text-left font-semibold text-gray-700">Contact</th>
                      <th className="px-4 py-2 text-left font-semibold text-gray-700">Severity</th>
                      <th className="px-4 py-2 text-left font-semibold text-gray-700">Exposure</th>
                      <th className="px-4 py-2 text-left font-semibold text-gray-700">Drip Stage</th>
                      <th className="px-4 py-2 text-left font-semibold text-gray-700">Request</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {complianceFlaggedEntities.slice(0, 20).map((entity: any) => {
                      const drip = (dripRecords || []).find((d: any) => d.entity_id === entity.id);
                      const stageLabels = ['Enrolled', 'Day 3 Due', 'Day 7 Due', 'Day 14 Due', 'Complete'];
                      return (
                        <tr key={entity.id}>
                          <td className="px-4 py-2 font-medium text-gray-900">
                            {entity.entity_name}
                            {entity.contactName && entity.contactName !== entity.entity_name && (
                              <div className="text-xs text-gray-500">{entity.contactName}</div>
                            )}
                          </td>
                          <td className="px-4 py-2 text-gray-600">{entity.requests?.clients?.name || '—'}</td>
                          <td className="px-4 py-2">
                            {entity.contactEmail ? (
                              <a href={`mailto:${entity.contactEmail}`} className="text-blue-600 hover:text-blue-800 text-xs underline">
                                {entity.contactEmail}
                              </a>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-yellow-50 text-yellow-700 text-xs rounded border border-yellow-200">
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01" /></svg>
                                No email
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2">
                            <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-bold ${
                              entity.hasCritical ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'
                            }`}>
                              {entity.hasCritical ? 'CRITICAL' : 'WARNING'}
                            </span>
                          </td>
                          <td className="px-4 py-2 text-xs text-gray-700 font-medium">
                            {entity.totalExposure > 0 ? `$${entity.totalExposure.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : '—'}
                          </td>
                          <td className="px-4 py-2">
                            {drip ? (
                              <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                                drip.consultation_booked ? 'bg-emerald-100 text-emerald-800' :
                                drip.unsubscribed ? 'bg-gray-100 text-gray-500' :
                                'bg-blue-100 text-blue-800'
                              }`}>
                                {drip.consultation_booked ? 'Booked' :
                                 drip.unsubscribed ? 'Unsub' :
                                 stageLabels[drip.drip_stage] || `Stage ${drip.drip_stage}`}
                              </span>
                            ) : (
                              <span className="text-xs text-gray-400">Not enrolled</span>
                            )}
                          </td>
                          <td className="px-4 py-2">
                            <Link
                              href={`/admin/requests/${entity.request_id}`}
                              className="text-blue-600 hover:text-blue-800 underline font-medium"
                            >
                              {entity.requests?.loan_number || 'View'}
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {complianceFlaggedEntities.length > 20 && (
                  <p className="text-xs text-gray-500 mt-2 px-4">
                    Showing 20 of {complianceFlaggedEntities.length} flagged entities
                  </p>
                )}
              </div>
            </div>
          </div>
          </details>
        )}

        {/* Compliance Opportunities — Breakdown by flag type for tax prep/planning outreach */}
        {complianceOpportunities.totalExposure > 0 && (
          <div className="mb-12">
            <h2 className="text-xl sm:text-2xl font-bold text-mt-dark mb-4">
              Compliance Opportunities
              <span className="ml-3 text-sm font-normal text-gray-500">
                ${complianceOpportunities.totalExposure.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} total exposure
              </span>
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              {[
                { label: 'Balance Due', count: complianceOpportunities.balanceDue.length, color: 'border-red-300 bg-red-50 text-red-800', service: 'Tax Resolution' },
                { label: 'Unfiled Returns', count: complianceOpportunities.unfiledReturns.length, color: 'border-red-300 bg-red-50 text-red-800', service: 'Tax Prep' },
                { label: 'Liens / Levies', count: complianceOpportunities.liensLevies.length, color: 'border-orange-300 bg-orange-50 text-orange-800', service: 'Lien Release' },
                { label: 'Installment / OIC', count: complianceOpportunities.penalties.length, color: 'border-amber-300 bg-amber-50 text-amber-800', service: 'Tax Planning' },
                { label: 'Audits / SFR', count: complianceOpportunities.audits.length, color: 'border-purple-300 bg-purple-50 text-purple-800', service: 'Audit Defense' },
              ].filter(item => item.count > 0).map((item, i) => (
                <div key={i} className={`border rounded-lg p-4 ${item.color}`}>
                  <div className="text-3xl font-bold">{item.count}</div>
                  <div className="text-sm font-semibold mt-1">{item.label}</div>
                  <div className="text-xs opacity-75 mt-0.5">{item.service}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Client Stats — collapsed by default */}
        <details className="mb-8 group">
          <summary className="list-none cursor-pointer flex items-center justify-between bg-white rounded-lg shadow px-5 py-3 border border-gray-200 hover:border-mt-green/40 transition-colors">
            <div className="flex items-baseline gap-3 flex-wrap">
              <span className="text-base font-bold text-mt-dark">Client Overview</span>
              <span className="text-xs text-gray-500">
                {(clients || []).length} client{(clients || []).length !== 1 ? 's' : ''} ·
                {' '}{(clients || []).filter((c: any) => c.free_trial).length} on trial ·
                {' '}{totalStats.completed} entities completed across all clients
              </span>
            </div>
            <svg className="w-4 h-4 text-gray-400 transition-transform group-open:rotate-180 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </summary>
          <div className="mt-4">
          <div className="bg-white rounded-lg shadow overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-3 sm:px-6 py-3 text-left text-xs sm:text-sm font-semibold text-gray-700">Client</th>
                    <th className="px-3 sm:px-6 py-3 text-left text-xs sm:text-sm font-semibold text-gray-700 hidden sm:table-cell">Free Trial</th>
                    <th className="px-3 sm:px-6 py-3 text-left text-xs sm:text-sm font-semibold text-gray-700">Total</th>
                    <th className="px-3 sm:px-6 py-3 text-left text-xs sm:text-sm font-semibold text-gray-700">Done</th>
                    <th className="px-3 sm:px-6 py-3 text-left text-xs sm:text-sm font-semibold text-gray-700 hidden md:table-cell">Pending</th>
                    <th className="px-3 sm:px-6 py-3 text-left text-xs sm:text-sm font-semibold text-gray-700 hidden md:table-cell">Failed</th>
                    <th className="px-3 sm:px-6 py-3 text-left text-xs sm:text-sm font-semibold text-gray-700 hidden lg:table-cell">API Usage</th>
                    <th className="px-3 sm:px-6 py-3 text-right text-xs sm:text-sm font-semibold text-gray-700 hidden sm:table-cell">Revenue</th>
                    <th className="px-3 sm:px-6 py-3 text-left text-xs sm:text-sm font-semibold text-gray-700 hidden lg:table-cell">Payment</th>
                    <th className="px-3 sm:px-6 py-3 text-left text-xs sm:text-sm font-semibold text-gray-700 hidden md:table-cell">Completion</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {Object.entries(clientStats).map(([clientId, stats]) => {
                    const completionRate =
                      stats.total > 0 ? Math.round((stats.completed / stats.total) * 100) : 0;
                    const clientObj = clients?.find((c) => c.id === clientId);
                    return (
                      <tr key={clientId} className="hover:bg-gray-50 transition-colors">
                        <td className="px-3 sm:px-6 py-3 sm:py-4 font-semibold text-xs sm:text-sm text-mt-dark">{stats.name}</td>
                        <td className="px-3 sm:px-6 py-3 sm:py-4 hidden sm:table-cell">
                          <FreeTrialToggle
                            clientId={clientId}
                            clientName={stats.name}
                            initialValue={clientObj?.free_trial ?? true}
                          />
                        </td>
                        <td className="px-3 sm:px-6 py-3 sm:py-4 text-xs sm:text-sm text-gray-600">{stats.total}</td>
                        <td className="px-3 sm:px-6 py-3 sm:py-4">
                          <span className="text-xs sm:text-sm font-medium text-green-600">{stats.completed}</span>
                        </td>
                        <td className="px-3 sm:px-6 py-3 sm:py-4 hidden md:table-cell">
                          <span className="text-sm font-medium text-yellow-600">{stats.pending}</span>
                        </td>
                        <td className="px-3 sm:px-6 py-3 sm:py-4 hidden md:table-cell">
                          <span className="text-sm font-medium text-red-600">{stats.failed}</span>
                        </td>
                        <td className="px-3 sm:px-6 py-3 sm:py-4 hidden lg:table-cell">
                          {stats.api_key ? (
                            <span className="text-sm text-gray-700">
                              {stats.employment_count}
                              {stats.api_request_limit && (
                                <span className="text-gray-400"> / {stats.api_request_limit}</span>
                              )}
                            </span>
                          ) : (
                            <span className="text-xs text-gray-400">—</span>
                          )}
                        </td>
                        <td className="px-3 sm:px-6 py-3 sm:py-4 text-right hidden sm:table-cell">
                          {(clientRevenuePrev[clientId] || 0) > 0 ? (
                            <div>
                              <span className="text-xs sm:text-sm font-bold text-mt-dark">{formatCurrency(clientRevenuePrev[clientId] || 0)}</span>
                              <p className="text-xs text-gray-400">{clientRevenueEntitiesPrev[clientId] || 0} entities</p>
                            </div>
                          ) : (
                            <span className="text-xs text-gray-400">$0.00</span>
                          )}
                        </td>
                        <td className="px-3 sm:px-6 py-3 sm:py-4 hidden lg:table-cell">
                          {clientObj?.billing_payment_method ? (
                            <span className="inline-block px-2 py-0.5 rounded text-xs font-semibold bg-green-100 text-green-700">
                              {clientObj.billing_payment_method.toUpperCase()}
                            </span>
                          ) : (
                            <span className="text-xs text-gray-400">Not set</span>
                          )}
                        </td>
                        <td className="px-3 sm:px-6 py-3 sm:py-4 hidden md:table-cell">
                          <div className="flex items-center gap-2">
                            <div className="w-24 bg-gray-200 rounded-full h-2">
                              <div
                                className="bg-mt-green h-2 rounded-full"
                                style={{ width: `${completionRate}%` }}
                              ></div>
                            </div>
                            <span className="text-sm font-medium text-gray-700">{completionRate}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          </div>
        </details>

        {/* Recent Invoices — collapsed by default */}
        {(allInvoices || []).length > 0 && (
          <details className="mb-8 group">
            <summary className="list-none cursor-pointer flex items-center justify-between bg-white rounded-lg shadow px-5 py-3 border border-gray-200 hover:border-mt-green/40 transition-colors">
              <div className="flex items-baseline gap-3 flex-wrap">
                <span className="text-base font-bold text-mt-dark">Recent Invoices</span>
                <span className="text-xs text-gray-500">
                  Last {(allInvoices || []).length} ·
                  {' '}{(allInvoices || []).filter((i: any) => i.status === 'paid').length} paid ·
                  {' '}{(allInvoices || []).filter((i: any) => i.status === 'sent').length} sent
                </span>
              </div>
              <div className="flex items-center gap-3">
                <Link
                  href="/admin/billing"
                  className="text-xs font-medium text-mt-green hover:underline"
                >
                  Full billing →
                </Link>
                <svg className="w-4 h-4 text-gray-400 transition-transform group-open:rotate-180 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            </summary>
          <div className="mt-4">
            <div className="bg-white rounded-lg shadow overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Invoice #</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Client</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Period</th>
                      <th className="px-6 py-3 text-right text-sm font-semibold text-gray-700">Entities</th>
                      <th className="px-6 py-3 text-right text-sm font-semibold text-gray-700">Amount</th>
                      <th className="px-6 py-3 text-center text-sm font-semibold text-gray-700">Status</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-700">Due Date</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {(allInvoices || []).map((inv: any) => (
                      <tr key={inv.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-6 py-3">
                          <code className="text-sm font-mono text-mt-dark">{inv.invoice_number}</code>
                        </td>
                        <td className="px-6 py-3 text-sm text-gray-700">{inv.clients?.name || '—'}</td>
                        <td className="px-6 py-3 text-sm text-gray-600">
                          {new Date(inv.billing_period_start).toLocaleDateString('en-US', { year: 'numeric', month: 'short' })}
                        </td>
                        <td className="px-6 py-3 text-right text-sm text-gray-700">{inv.total_entities}</td>
                        <td className="px-6 py-3 text-right text-sm font-bold text-mt-dark">{formatCurrency(inv.total_amount)}</td>
                        <td className="px-6 py-3 text-center">
                          <span className={`inline-block px-3 py-1 rounded-full text-xs font-semibold ${
                            inv.status === 'paid' ? 'bg-green-100 text-green-700' :
                            inv.status === 'overdue' ? 'bg-red-100 text-red-700' :
                            inv.status === 'sent' ? 'bg-blue-100 text-blue-700' :
                            'bg-gray-100 text-gray-700'
                          }`}>
                            {inv.status.charAt(0).toUpperCase() + inv.status.slice(1)}
                          </span>
                        </td>
                        <td className="px-6 py-3 text-sm text-gray-600">
                          {inv.due_date ? formatDate(inv.due_date) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          </details>
        )}

        {/* All Requests — anchor target from action ribbon. Stays
            visible by default since it's the live activity feed. */}
        <div id="all-requests" className="scroll-mt-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
            <h2 className="text-xl sm:text-2xl font-bold text-mt-dark">All Requests</h2>
            <div className="flex rounded-lg border border-gray-300 overflow-hidden text-sm">
              {(() => {
                const baseParams = new URLSearchParams();
                if (searchFilter) baseParams.set('search', searchFilter);
                if (statusFilter && statusFilter !== 'all') baseParams.set('status', statusFilter);
                const allHref = baseParams.toString() ? `/admin?${baseParams.toString()}` : '/admin';

                const transcriptParams = new URLSearchParams(baseParams);
                transcriptParams.set('type', 'transcript');

                const employmentParams = new URLSearchParams(baseParams);
                employmentParams.set('type', 'employment');

                return (
                  <>
                    <Link
                      href={allHref}
                      className={`px-4 py-2 font-medium transition-colors ${
                        !productTypeFilter || productTypeFilter === 'all'
                          ? 'bg-mt-dark text-white'
                          : 'bg-white text-gray-600 hover:bg-gray-50'
                      }`}
                    >
                      All
                    </Link>
                    <Link
                      href={`/admin?${transcriptParams.toString()}`}
                      className={`px-4 py-2 font-medium border-l border-gray-300 transition-colors ${
                        productTypeFilter === 'transcript'
                          ? 'bg-mt-dark text-white'
                          : 'bg-white text-gray-600 hover:bg-gray-50'
                      }`}
                    >
                      Transcripts
                    </Link>
                    <Link
                      href={`/admin?${employmentParams.toString()}`}
                      className={`px-4 py-2 font-medium border-l border-gray-300 transition-colors ${
                        productTypeFilter === 'employment'
                          ? 'bg-mt-dark text-white'
                          : 'bg-white text-gray-600 hover:bg-gray-50'
                      }`}
                    >
                      Employment
                    </Link>
                  </>
                );
              })()}
            </div>
          </div>

          {/* Search and Status Filter */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 mb-6">
            <form className="flex items-center gap-2 sm:gap-4 flex-1">
              {productTypeFilter && productTypeFilter !== 'all' && (
                <input type="hidden" name="type" value={productTypeFilter} />
              )}
              {statusFilter && statusFilter !== 'all' && (
                <input type="hidden" name="status" value={statusFilter} />
              )}
              <div className="relative flex-1 max-w-sm">
                <input
                  type="text"
                  name="search"
                  defaultValue={searchFilter || ''}
                  placeholder="Search by entity name, loan number, or client..."
                  className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent"
                />
                <svg className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <button type="submit" className="px-4 py-2 text-sm font-medium text-white bg-mt-green rounded-lg hover:bg-mt-green/90 transition-colors">
                Search
              </button>
            </form>
            <form>
              {productTypeFilter && productTypeFilter !== 'all' && (
                <input type="hidden" name="type" value={productTypeFilter} />
              )}
              {searchFilter && (
                <input type="hidden" name="search" value={searchFilter} />
              )}
              <select
                name="status"
                defaultValue={statusFilter || 'all'}
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent"
                // Use form submission via noscript-friendly approach
                // The onchange below won't work in a Server Component, so users submit the form
              >
                <option value="all">All Statuses</option>
                <option value="submitted">Submitted</option>
                <option value="8821_sent">8821 Sent</option>
                <option value="8821_signed">8821 Signed</option>
                <option value="irs_queue">IRS Queue</option>
                <option value="processing">Processing</option>
                <option value="completed">Completed</option>
                <option value="failed">Failed</option>
              </select>
              <button type="submit" className="ml-2 px-4 py-2 text-sm font-medium text-mt-dark border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
                Filter
              </button>
            </form>
            {(searchFilter || (statusFilter && statusFilter !== 'all')) && (
              <Link
                href={productTypeFilter && productTypeFilter !== 'all' ? `/admin?type=${productTypeFilter}` : '/admin'}
                className="text-sm text-gray-500 hover:text-gray-700 underline"
              >
                Clear filters
              </Link>
            )}
          </div>

          {/* Time-window + legacy-visibility quick filters */}
          {(() => {
            const base = new URLSearchParams();
            if (productTypeFilter && productTypeFilter !== 'all') base.set('type', productTypeFilter);
            if (searchFilter) base.set('search', searchFilter);
            if (statusFilter && statusFilter !== 'all') base.set('status', statusFilter);
            const mkHref = (override: Record<string, string | null>) => {
              const p = new URLSearchParams(base);
              // Any change resets to page 0
              for (const [k, v] of Object.entries(override)) {
                if (v === null) p.delete(k);
                else p.set(k, v);
              }
              const s = p.toString();
              return s ? `/admin?${s}` : '/admin';
            };
            const windows: [string, string][] = [
              ['1', '24h'],
              ['7', '7d'],
              ['30', '30d'],
              ['all', 'All time'],
            ];
            const activeWindow = windowDays === null ? 'all' : String(windowDays);
            return (
              <div className="flex flex-wrap items-center gap-2 mb-4">
                <span className="text-xs text-gray-500 mr-1">Recent:</span>
                {windows.map(([v, label]) => {
                  const isActive = activeWindow === v;
                  return (
                    <Link
                      key={v}
                      href={mkHref({ window: v, page: null })}
                      className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                        isActive
                          ? 'bg-mt-dark text-white border-mt-dark'
                          : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                      }`}
                    >
                      {label}
                    </Link>
                  );
                })}
                <span className="text-xs text-gray-400 mx-2">•</span>
                <Link
                  href={mkHref({ hideLegacy: hideLegacy ? 'false' : null, page: null })}
                  className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                    hideLegacy
                      ? 'bg-gray-100 text-gray-600 border-gray-300 hover:bg-gray-200'
                      : 'bg-amber-100 text-amber-800 border-amber-300 hover:bg-amber-200'
                  }`}
                  title={hideLegacy
                    ? 'Pre-portal ModernTax deliveries (HIST-* loan numbers, imported via Apr 15 Dropbox backfill) are hidden. Click to show them.'
                    : 'Pre-portal ModernTax deliveries (HIST-* loan numbers, imported via Apr 15 Dropbox backfill) are shown. Click to hide them.'}
                >
                  {hideLegacy ? 'Hiding pre-portal (HIST-*)' : 'Showing pre-portal (HIST-*)'}
                </Link>
                {searchFilter && (
                  <span className="text-xs text-gray-400 italic">
                    Window/legacy filters ignored while searching.
                  </span>
                )}
              </div>
            );
          })()}

          {/* Result count */}
          <p className="text-sm text-gray-500 mb-4">
            Showing {visibleRequests.length === totalFiltered
              ? `${totalFiltered} request${totalFiltered !== 1 ? 's' : ''}`
              : `${pageIndex * ADMIN_REQUESTS_PAGE_SIZE + 1}–${pageIndex * ADMIN_REQUESTS_PAGE_SIZE + visibleRequests.length} of ${totalFiltered}`}
            {searchFilter && <span> matching &ldquo;{searchFilter}&rdquo;</span>}
            {statusFilter && statusFilter !== 'all' && <span> with status {formatStatus(statusFilter)}</span>}
            {!searchFilter && windowDays !== null && <span> updated in last {windowDays === 1 ? '24h' : `${windowDays} days`}</span>}
            {!searchFilter && hideLegacy && <span> (pre-portal HIST-* deliveries hidden)</span>}
            <span className="text-gray-400"> · sorted by last activity</span>
          </p>
          <div className="bg-white rounded-lg shadow overflow-hidden">
            {visibleRequests.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="px-3 sm:px-6 py-3 text-left text-xs sm:text-sm font-semibold text-gray-700">Client</th>
                      <th className="px-3 sm:px-6 py-3 text-left text-xs sm:text-sm font-semibold text-gray-700 hidden md:table-cell">Type</th>
                      <th className="px-3 sm:px-6 py-3 text-left text-xs sm:text-sm font-semibold text-gray-700">Account</th>
                      <th className="px-3 sm:px-6 py-3 text-left text-xs sm:text-sm font-semibold text-gray-700">Status</th>
                      <th className="px-3 sm:px-6 py-3 text-left text-xs sm:text-sm font-semibold text-gray-700 hidden lg:table-cell">Entity Names</th>
                      <th className="px-3 sm:px-6 py-3 text-left text-xs sm:text-sm font-semibold text-gray-700 hidden sm:table-cell">Progress</th>
                      <th className="px-3 sm:px-6 py-3 text-left text-xs sm:text-sm font-semibold text-gray-700 hidden md:table-cell">Submitted</th>
                      <th className="px-3 sm:px-6 py-3 text-left text-xs sm:text-sm font-semibold text-gray-700">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {visibleRequests.map((request: any) => (
                      <tr key={request.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-3 sm:px-6 py-3 sm:py-4">
                          <span className="text-xs sm:text-sm font-medium text-gray-700">
                            {request.clients?.name || 'Unknown'}
                          </span>
                        </td>
                        <td className="px-3 sm:px-6 py-3 sm:py-4 hidden md:table-cell">
                          <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${
                            request.product_type === 'employment'
                              ? 'bg-indigo-100 text-indigo-700'
                              : 'bg-blue-100 text-blue-700'
                          }`}>
                            {request.product_type === 'employment' ? 'Employment' : 'Transcript'}
                          </span>
                        </td>
                        <td className="px-3 sm:px-6 py-3 sm:py-4">
                          <code className="text-xs sm:text-sm font-mono text-mt-dark">{request.loan_number}</code>
                        </td>
                        <td className="px-3 sm:px-6 py-3 sm:py-4">
                          {(() => {
                            const entities = request.request_entities || [];
                            const completedCount = entities.filter((e: any) => e.status === 'completed').length;
                            const allComplete = entities.length > 0 && completedCount === entities.length;
                            const anyFailed = entities.some((e: any) => e.status === 'failed');
                            const displayStatus = allComplete ? 'completed' : anyFailed ? 'failed' : request.status;
                            return (
                              <span className={`inline-block px-3 py-1 rounded-full text-xs font-semibold ${getStatusBadgeColor(displayStatus as RequestStatus)}`}>
                                {formatStatus(displayStatus)}
                              </span>
                            );
                          })()}
                        </td>
                        <td className="px-3 sm:px-6 py-3 sm:py-4 hidden lg:table-cell">
                          {(() => {
                            const entities = request.request_entities || [];
                            if (entities.length === 0) return <span className="text-xs text-gray-400">None</span>;
                            const searchLower = searchFilter?.toLowerCase();
                            return (
                              <div className="flex flex-wrap gap-1 max-w-xs">
                                {entities.map((e: any) => {
                                  const isMatch = searchLower && e.entity_name?.toLowerCase().includes(searchLower);
                                  return (
                                    <span
                                      key={e.id}
                                      className={`inline-block px-2 py-0.5 rounded text-xs ${
                                        isMatch
                                          ? 'bg-yellow-100 text-yellow-800 font-semibold ring-1 ring-yellow-300'
                                          : e.status === 'completed'
                                          ? 'bg-green-50 text-green-700'
                                          : e.status === 'failed'
                                          ? 'bg-red-50 text-red-700'
                                          : 'bg-gray-100 text-gray-700'
                                      }`}
                                    >
                                      {e.entity_name}
                                    </span>
                                  );
                                })}
                              </div>
                            );
                          })()}
                        </td>
                        <td className="px-3 sm:px-6 py-3 sm:py-4 text-sm text-gray-600 hidden sm:table-cell">
                          {(() => {
                            const entities = request.request_entities || [];
                            const completedCount = entities.filter((e: any) => e.status === 'completed').length;
                            return (
                              <span>
                                <span className="font-medium text-green-600">{completedCount}</span>
                                <span className="text-gray-400"> / </span>
                                <span>{entities.length}</span>
                              </span>
                            );
                          })()}
                        </td>
                        <td className="px-3 sm:px-6 py-3 sm:py-4 text-sm text-gray-600 hidden md:table-cell">
                          {formatDate(request.created_at)}
                        </td>
                        <td className="px-3 sm:px-6 py-3 sm:py-4 flex gap-2">
                          <Link
                            href={`/admin/requests/${request.id}`}
                            className="text-mt-green hover:underline font-medium text-sm"
                          >
                            Manage
                          </Link>
                          <Link
                            href={`/request/${request.id}`}
                            className="text-gray-400 hover:text-gray-600 text-sm"
                          >
                            View
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="px-6 py-12 text-center">
                <p className="text-gray-500 font-medium">No requests match the current filters</p>
                <p className="text-xs text-gray-400 mt-1">Try widening the time window or showing pre-portal (HIST-*) deliveries.</p>
              </div>
            )}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (() => {
            const base = new URLSearchParams();
            if (productTypeFilter && productTypeFilter !== 'all') base.set('type', productTypeFilter);
            if (searchFilter) base.set('search', searchFilter);
            if (statusFilter && statusFilter !== 'all') base.set('status', statusFilter);
            if (windowFilterRaw) base.set('window', windowFilterRaw);
            if (hideLegacyRaw === 'false') base.set('hideLegacy', 'false');
            const mkPageHref = (p: number) => {
              const params = new URLSearchParams(base);
              if (p > 0) params.set('page', String(p));
              const s = params.toString();
              return s ? `/admin?${s}` : '/admin';
            };
            const prevDisabled = pageIndex === 0;
            const nextDisabled = pageIndex >= totalPages - 1;
            return (
              <div className="flex items-center justify-between mt-4 text-sm">
                <div className="text-gray-500">
                  Page <span className="font-semibold text-gray-700">{pageIndex + 1}</span> of {totalPages}
                </div>
                <div className="flex gap-2">
                  {prevDisabled ? (
                    <span className="px-3 py-1.5 text-xs rounded border border-gray-200 text-gray-300 cursor-not-allowed">
                      ← Prev
                    </span>
                  ) : (
                    <Link
                      href={mkPageHref(pageIndex - 1)}
                      className="px-3 py-1.5 text-xs rounded border border-gray-300 text-gray-700 hover:bg-gray-50"
                    >
                      ← Prev
                    </Link>
                  )}
                  {nextDisabled ? (
                    <span className="px-3 py-1.5 text-xs rounded border border-gray-200 text-gray-300 cursor-not-allowed">
                      Next →
                    </span>
                  ) : (
                    <Link
                      href={mkPageHref(pageIndex + 1)}
                      className="px-3 py-1.5 text-xs rounded border border-gray-300 text-gray-700 hover:bg-gray-50"
                    >
                      Next →
                    </Link>
                  )}
                </div>
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
