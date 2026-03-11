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
}

export type TidKind = 'EIN' | 'SSN';

export type IntakeMethod = 'csv' | 'pdf' | 'manual';

export type UserRole = 'processor' | 'manager' | 'admin' | 'expert';

export type NotificationType = 'confirmation' | 'completion' | 'nudge' | 'batch_complete' | 'expert_assigned' | 'expert_completed' | 'expert_issue' | 'sla_warning';

export type AssignmentStatus = 'assigned' | 'in_progress' | 'completed' | 'failed' | 'reassigned';

export type BatchStatus = 'processing' | 'completed' | 'failed';

/**
 * Client - A lending partner (Centerstone, TMC Financing, Clearfirm)
 */
export interface Client {
  id: string;
  name: string;
  slug: string;
  domain: string | null;
  logo_url: string | null;
  intake_methods: IntakeMethod[];
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
  role: UserRole;
  client_id: string | null;
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
 * Request - One per loan/credit application
 */
export interface Request {
  id: string;
  client_id: string;
  requested_by: string;
  batch_id: string | null;
  loan_number: string;
  intake_method: IntakeMethod;
  status: RequestStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
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
  signature_id: string | null;
  signature_created_at: string | null;
  signed_8821_url: string | null;
  status: EntityStatus;
  gross_receipts: Record<string, unknown> | null;
  compliance_score: number | null;
  transcript_urls: string[] | null;
  completed_at: string | null;
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
