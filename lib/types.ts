/**
 * ModernTax Portal Type Definitions
 */

export enum RequestStatus {
  SUBMITTED = 'submitted',
  FORM_8821_SENT = '8821_sent',
  FORM_8821_SIGNED = '8821_signed',
  IRS_QUEUE = 'irs_queue',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export enum FormType {
  FORM_1040 = '1040',
  FORM_1065 = '1065',
  FORM_1120 = '1120',
  FORM_1120S = '1120S',
}

export enum UserRole {
  PROCESSOR = 'processor',
  MANAGER = 'manager',
  ADMIN = 'admin',
}

export enum NotificationType {
  CONFIRMATION = 'confirmation',
  COMPLETION = 'completion',
  NUDGE = 'nudge',
}

/**
 * Client
 * Represents a lending partner (Centerstone, TMC Financing, Clearfirm)
 */
export interface Client {
  id: string;
  name: string;
  slug: string;
  domain: string | null;
  logo_url: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Profile
 * Extends Supabase auth.users with role and client association
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
 * Request
 * A verification request for IRS transcripts
 */
export interface Request {
  id: string;
  client_id: string;
  requested_by: string;
  account_number: string;
  status: RequestStatus;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  notes: string | null;
}

/**
 * RequestEntity
 * Individual entity (business/person) within a request
 */
export interface RequestEntity {
  id: string;
  request_id: string;
  entity_name: string;
  ein: string;
  form_type: FormType;
  years: string[];
  status: string;
  gross_receipts: Record<string, unknown> | null;
  compliance_score: number | null;
  transcript_urls: string[] | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Notification
 * Email notification sent to user
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
 * DailyNudgeStats
 * Stats for daily nudge email
 */
export interface DailyNudgeStats {
  pending_count: number;
  completed_count: number;
  in_progress_count: number;
  oldest_pending_days: number | null;
}

/**
 * RequestWithEntities
 * Request with expanded entity data
 */
export interface RequestWithEntities extends Request {
  entities: RequestEntity[];
  requested_by_profile?: Profile;
  client?: Client;
}
