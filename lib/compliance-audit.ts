/**
 * Compliance audit — sweep every entity's stored transcript intelligence and
 * surface the ones with an open IRS compliance issue, ranked by exposure.
 *
 * This is the data layer behind the admin Compliance Audit board, where the
 * team turns a flagged case into a custom, billable-hour resolution engagement
 * (no fixed SKU — each case is priced on its own). It reads only pre-computed
 * signals already on `request_entities.gross_receipts` (payroll_liability_report,
 * erc_recovery, per-year compliance screening, resolution/filing state) so the
 * sweep is cheap and never re-parses transcript HTML.
 *
 * Pure + deterministic: `auditEntities(rows)` takes fetched rows and returns
 * ranked cases. Matt 2026-07-28.
 */

export type Severity = 'CRITICAL' | 'WARNING' | 'INFO';

export interface ComplianceCase {
  entityId: string;
  entityName: string;
  tid: string | null;
  formType: string | null;
  status: string | null;
  client: string;
  /** Machine issue codes present on this entity. */
  issues: string[];
  /** Human-readable issue labels (aligned to `issues`). */
  issueLabels: string[];
  /** Best-known dollar exposure (0 when flags exist but no balance parsed). */
  exposure: number;
  severity: Severity;
  complianceScore: number | null;
  /** One-line summary for the board row. */
  summary: string;
  /** True if a Direct purchase order / token already exists for this entity. */
  hasDirectPO: boolean;
  directToken?: string;
  /** Engagements already quoted/paid against this case. */
  engagementStatus?: 'quoted' | 'paid' | null;
}

export interface AuditRow {
  id: string;
  entity_name: string;
  tid: string | null;
  form_type: string | null;
  status: string | null;
  compliance_score: number | null;
  gross_receipts: any;
  requests?: { clients?: { name?: string | null } | null } | null;
}

const ISSUE_LABELS: Record<string, string> = {
  payroll_liability: 'Unpaid payroll tax',
  erc_undelivered: 'Undelivered ERC refund',
  screening_flags: 'Compliance flags',
  unfiled_returns: 'Unfiled returns',
  backfiling: 'Back-filing engagement',
  low_score: 'Low compliance score',
};

const num = (x: any): number => Number(x) || 0;

function worse(a: Severity, b: Severity): Severity {
  const rank = { CRITICAL: 3, WARNING: 2, INFO: 1 } as const;
  return rank[a] >= rank[b] ? a : b;
}

/** Audit a single entity row → a case, or null if nothing is flagged. */
export function auditEntity(row: AuditRow): ComplianceCase | null {
  const gr = row.gross_receipts || {};
  const issues: string[] = [];
  let exposure = 0;
  let severity: Severity = 'INFO';

  // 1) Unpaid payroll / trust-fund liability (the S3 pattern).
  const pl = gr.payroll_liability_report;
  if (pl && num(pl.total_account_balance) > 0) {
    issues.push('payroll_liability');
    exposure = Math.max(exposure, num(pl.total_balance_plus_accruals) || num(pl.total_account_balance));
    severity = worse(severity, 'CRITICAL');
  }

  // 2) Undelivered ERC / refund dollars sitting at the IRS.
  const erc = gr.erc_recovery;
  const undelivered = num(erc?.total_undelivered ?? erc?.recovery?.total_undelivered);
  if (undelivered > 0) {
    issues.push('erc_undelivered');
    exposure = Math.max(exposure, undelivered);
    severity = worse(severity, 'WARNING');
  }

  // 3) Per-year compliance screening flags + parsed balances.
  let yearExposure = 0;
  let hasFlags = false;
  let flagSeverity: Severity = 'INFO';
  for (const v of Object.values(gr)) {
    if (v && typeof v === 'object' && ((v as any).flags || (v as any).financials || (v as any).severity)) {
      const o = v as any;
      if (Array.isArray(o.flags) && o.flags.length) hasFlags = true;
      if (o.severity === 'CRITICAL') flagSeverity = 'CRITICAL';
      else if (o.severity === 'WARNING') flagSeverity = worse(flagSeverity, 'WARNING');
      const f = o.financials || {};
      yearExposure += num(f.accountBalance) + num(f.accruedPenalty) + num(f.accruedInterest);
    }
  }
  if (hasFlags || yearExposure > 0) {
    issues.push('screening_flags');
    exposure = Math.max(exposure, yearExposure);
    severity = worse(severity, flagSeverity);
  }

  // 4) Delinquent / back-filing state.
  if (Array.isArray(gr.resolution?.unfiled_years) && gr.resolution.unfiled_years.length) {
    issues.push('unfiled_returns');
    severity = worse(severity, 'WARNING');
  }
  if (num(gr.filing?.years_filed) > 0) issues.push('backfiling');

  // 5) Low compliance score as a catch-all signal.
  if (row.compliance_score != null && row.compliance_score < 70 && issues.length === 0) {
    issues.push('low_score');
    severity = worse(severity, 'WARNING');
  }

  if (issues.length === 0) return null;

  const po = gr.purchase_order;
  const engagements = Array.isArray(gr.engagements) ? gr.engagements : [];
  const engagementStatus = engagements.some((e: any) => e.status === 'paid')
    ? 'paid'
    : engagements.length
      ? 'quoted'
      : null;

  return {
    entityId: row.id,
    entityName: row.entity_name,
    tid: row.tid,
    formType: row.form_type,
    status: row.status,
    client: row.requests?.clients?.name || '—',
    issues,
    issueLabels: issues.map((i) => ISSUE_LABELS[i] || i),
    exposure: Math.round(exposure),
    severity,
    complianceScore: row.compliance_score,
    summary: summarize(issues, exposure, gr),
    hasDirectPO: !!po,
    directToken: gr.direct_token || undefined,
    engagementStatus,
  };
}

/** Audit + rank a batch of rows (exposure desc, then severity). */
export function auditEntities(rows: AuditRow[]): ComplianceCase[] {
  const cases = rows.map(auditEntity).filter((c): c is ComplianceCase => c !== null);
  const sevRank = { CRITICAL: 3, WARNING: 2, INFO: 1 } as const;
  return cases.sort((a, b) => b.exposure - a.exposure || sevRank[b.severity] - sevRank[a.severity]);
}

export interface AuditSummary {
  totalCases: number;
  bySeverity: Record<Severity, number>;
  totalExposure: number;
  withExposure: number;
}

export function summarizeAudit(cases: ComplianceCase[]): AuditSummary {
  const bySeverity = { CRITICAL: 0, WARNING: 0, INFO: 0 } as Record<Severity, number>;
  let totalExposure = 0;
  let withExposure = 0;
  for (const c of cases) {
    bySeverity[c.severity]++;
    totalExposure += c.exposure;
    if (c.exposure > 0) withExposure++;
  }
  return { totalCases: cases.length, bySeverity, totalExposure, withExposure };
}

function usd(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function summarize(issues: string[], exposure: number, gr: any): string {
  if (issues.includes('payroll_liability')) {
    const q = gr.payroll_liability_report?.quarters_with_balance;
    return `${usd(exposure)} unpaid payroll tax${q ? ` across ${q} quarters` : ''} — trust-fund / TFRP exposure.`;
  }
  if (issues.includes('erc_undelivered')) {
    return `${usd(exposure)} in ERC refunds returned undelivered — recoverable via Form 3911.`;
  }
  if (issues.includes('unfiled_returns')) {
    const y = gr.resolution?.unfiled_years?.length;
    return `${y || 'Multiple'} unfiled federal return${y === 1 ? '' : 's'}${exposure > 0 ? ` + ${usd(exposure)} balance` : ''}.`;
  }
  if (exposure > 0) return `${usd(exposure)} assessed balance with IRS compliance flags.`;
  return 'IRS compliance flags found on transcripts (audit / no-record / civil-penalty indicators).';
}
