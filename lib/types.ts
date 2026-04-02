/**
 * ModernTax Portal Type Definitions
 */

export type RequestStatus =
  | 'submitted'
  | '8821_sent'
  | '8821_signed'
  | 'irs_queue'
  | 'processing'
  | 'completed'
  | 'failed';

export type EntityStatus =
  | 'pending'
  | 'submitted'
  | '8821_sent'
  | '8821_signed'
  | 'irs_queue'
  | 'processing'
  | 'completed'
  | 'failed';

export enum FormType {
  FORM_1040 = '1040',
  FORM_1065 = '1065',
  FORM_1120 = '1120',
  FORM_1120S = '1120S',
  FORM_W2_INCOME = 'W2_INCOME',
}

export type TidKind = 'EIN' | 'SSN';

export type IntakeMethod = 'csv' | 'pdf' | 'manual' | 'api';

export type ProductType = 'transcript' | 'employment';

export type UserRole = 'processor' | 'manager' | 'admin' | 'expert';

export type NotificationType = 'confirmation' | 'completion' | 'nudge' | 'batch_complete' | 'expert_assigned' | 'expert_completed' | 'expert_issue' | 'sla_warning' | 'admin_daily_summary' | 'manager_weekly_summary' | 'product_updates_nudge';

export type InvoiceStatus = 'draft' | 'sent' | 'paid' | 'overdue';
export type PaymentMethod = 'ach' | 'wire';
export type WebhookDeliveryStatus = 'pending' | 'sending' | 'delivered' | 'failed' | 'dead';

export type AssignmentStatus = 'assigned' | 'in_progress' | 'completed' | 'failed' | 'reassigned';

export type BatchStatus = 'processing' | 'completed' | 'failed';

/**
 * Client - A lending partner (Centerstone, TMC Financing, Clearfirm) or API client (Employer.com)
 */
export interface Client {
  id: string;
  name: string;
  slug: string;
  domain: string | null;
  logo_url: string | null;
  intake_methods: IntakeMethod[];
  api_key: string | null;
  api_request_limit: number | null;
  webhook_url: string | null;
  webhook_secret: string | null;
  billing_payment_method: PaymentMethod | null;
  billing_ap_email: string | null;
  billing_ap_phone: string | null;
  billing_rate_pdf: number;
  billing_rate_csv: number;
  created_at: string;
  updated_at: string;
}

/**
 * Invoice - Monthly billing record for a client
 */
export interface Invoice {
  id: string;
  client_id: string;
  invoice_number: string;
  billing_period_start: string;
  billing_period_end: string;
  total_entities: number;
  total_amount: number;
  status: InvoiceStatus;
  payment_method: PaymentMethod | null;
  mercury_reference: string | null;
  due_date: string | null;
  sent_at: string | null;
  paid_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Profile - Extends Supabase auth.users with role and client association
 */
export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  title: string | null;
  role: UserRole;
  client_id: string | null;
  // Expert credential fields (Form 8821 Section 2)
  caf_number: string | null;
  ptin: string | null;
  phone_number: string | null;
  fax_number: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip_code: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Batch - Groups file uploads together
 */
export interface Batch {
  id: string;
  client_id: string;
  uploaded_by: string;
  intake_method: IntakeMethod;
  source_file_url: string | null;
  original_filename: string | null;
  entity_count: number;
  request_count: number;
  status: BatchStatus;
  error_message: string | null;
  created_at: string;
}

/**
 * Request - One per loan/credit application or employment verification
 */
export interface Request {
  id: string;
  client_id: string;
  requested_by: string;
  batch_id: string | null;
  loan_number: string;
  intake_method: IntakeMethod;
  product_type: ProductType;
  external_request_token: string | null;
  status: RequestStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

/**
 * EmploymentData - Structured W-2/1099 employment verification data
 */
export interface EmploymentEmployer {
  ein: string;
  name: string;
  address: string;
  gross_earnings: number;
  form_type?: string;
  is_peo?: boolean;
}

export interface EmploymentYearData {
  total_w2_income?: number;
  total_income?: number;
  employers: EmploymentEmployer[];
}

export interface EmploymentData {
  request_id: string;
  status: string;
  timestamp: string;
  taxpayer: {
    ssn_last_four: string;
    name: string;
  };
  employment_by_year: Record<string, EmploymentYearData>;
  summary: {
    total_employers: number;
    total_w2_income?: number;
    total_income?: number;
    years_covered: number[];
  };
  completed_at: string | null;
}

/**
 * RequestEntity - Individual entity/taxpayer within a request
 */
export interface RequestEntity {
  id: string;
  request_id: string;
  entity_name: string;
  tid: string;
  tid_kind: TidKind;
  address: string | null;
  city: string | null;
  state: string | null;
  zip_code: string | null;
  form_type: string;
  years: string[];
  signer_first_name: string | null;
  signer_last_name: string | null;
  signer_email: string | null;
  signature_id: string | null;
  signature_created_at: string | null;
  signed_8821_url: string | null;
  status: EntityStatus;
  employment_data: EmploymentData | null;
  gross_receipts: Record<string, unknown> | null;
  compliance_score: number | null;
  transcript_urls: string[] | null;
  transcript_html_urls: string[] | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * WebhookDelivery - Tracks outbound webhook delivery attempts
 */
export interface WebhookDelivery {
  id: string;
  request_id: string;
  client_id: string;
  webhook_url: string;
  payload: Record<string, unknown>;
  status: WebhookDeliveryStatus;
  attempts: number;
  max_attempts: number;
  last_attempt_at: string | null;
  last_status_code: number | null;
  last_error: string | null;
  next_retry_at: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Notification - Email notification sent to user
 */
export interface Notification {
  id: string;
  user_id: string;
  request_id: string | null;
  type: NotificationType;
  sent_at: string;
  channel: string;
  read_at: string | null;
}

/**
 * ExpertAssignment - Tracks assignment of entities to IRS experts
 */
export interface ExpertAssignment {
  id: string;
  entity_id: string;
  expert_id: string;
  assigned_by: string;
  assigned_at: string;
  completed_at: string | null;
  sla_deadline: string;
  sla_met: boolean | null;
  status: AssignmentStatus;
  miss_reason: string | null;
  expert_notes: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * ExpertAssignmentWithDetails - Assignment with joined entity and request data
 */
export interface ExpertAssignmentWithDetails extends ExpertAssignment {
  request_entities: RequestEntity;
  requests?: Request;
}

/**
 * ExpertPerformanceStats - Aggregated performance for admin view
 */
export interface ExpertPerformanceStats {
  expert_id: string;
  expert_name: string;
  expert_email: string;
  total_assigned: number;
  completed: number;
  failed: number;
  in_progress: number;
  sla_met_count: number;
  sla_missed_count: number;
  avg_completion_hours: number;
  completion_rate: number;
  sla_compliance_rate: number;
}

/**
 * DailyNudgeStats
 */
export interface DailyNudgeStats {
  pending_count: number;
  completed_count: number;
  in_progress_count: number;
  oldest_pending_days: number | null;
}

/**
 * AdminDailySummaryStats - Aggregated daily stats for admin email
 */
export interface AdminDailySummaryStats {
  new_requests_today: number;
  completions_today: number;
  failures_today: number;
  expert_completions_today: number;
  active_requests: number;
  expert_sla_compliance: number; // percentage
  total_entities_completed_today: number;
  total_entities_pending: number;
}

/**
 * ManagerWeeklySummaryStats - Aggregated weekly stats for manager email
 */
export interface ManagerWeeklySummaryStats {
  requests_submitted: number;
  requests_completed: number;
  requests_failed: number;
  entities_completed: number;
  avg_turnaround_hours: number | null;
  processor_breakdown: {
    name: string;
    submitted: number;
    completed: number;
  }[];
}

/**
 * RequestWithEntities - Request with expanded entity data
 */
export interface RequestWithEntities extends Request {
  request_entities: RequestEntity[];
  requested_by_profile?: Profile;
  client?: Client;
}

/**
 * BatchWithRequests - Batch with expanded request data
 */
export interface BatchWithRequests extends Batch {
  requests: Request[];
}

/**
 * ProductUpdate - A product feature update for announcements
 */
export interface ProductUpdate {
  title: string;
  description: string;
  tag?: string;
}

/**
 * CSV row from Centerstone XLSX upload
 */
export interface CsvRow {
  legal_name: string;
  tid: string;
  tid_kind: string;
  address: string;
  city: string;
  state: string;
  zip_code: string;
  signature_id: string;
  first_name: string;
  last_name: string;
  signature_created_at: string;
  credit_application_id: string;
  years: string;
  form: string;
}
