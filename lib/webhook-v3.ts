/**
 * Structured Webhook Payload Engine (v3)
 *
 * Delivers structured JSON as the primary payload with raw HTML as an optional
 * evidence attachment. Designed for ClearFirm v2.1 endpoints and any future
 * API partner that needs structured transcript data.
 *
 * Delivery model: Incremental per-record
 *   - Each uploaded transcript triggers a structured webhook keyed by record_type
 *   - BMF_ENTITY → entity_profile + form_discovery
 *   - 941/940 → employment_compliance
 *   - 1120/1120S/1065/1040 → financial_verification
 *   - On request completion → risk_signals + complete signal
 *
 * Payload contract:
 *   {
 *     request_token, status, record_id, record_type, generated_at,
 *     entity: { legal_name, ein, ... },
 *     data: { ... },            // record_type-specific structured data
 *     raw_html?: string         // optional evidence attachment
 *   }
 */

import { SupabaseClient } from '@supabase/supabase-js';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RecordType =
  | 'entity_profile'
  | 'form_discovery'
  | 'employment_compliance'
  | 'financial_verification'
  | 'risk_signals'
  | 'credit_recommendation';

export type WebhookV3Status = 'partial' | 'complete' | 'error';

export interface EntityAddress {
  street: string | null;
  city: string | null;
  state: string | null;
  zip_code: string | null;
}

export interface EntityPrincipal {
  full_name: string | null;
  title: string | null;
}

export interface WebhookV3Entity {
  legal_name: string;
  submitted_name: string;
  ein: string;
  entity_type: string | null;
  state: string | null;
  address: EntityAddress;
  principal: EntityPrincipal | null;
}

/** Top-level v3 webhook payload */
export interface WebhookV3Payload {
  request_token: string;
  status: WebhookV3Status;
  record_id: string;
  record_type: RecordType;
  generated_at: string;
  entity: WebhookV3Entity;
  data: Record<string, unknown>;
  raw_html?: string;
  supersedes_record_id?: string;
}

/** Lightweight completion signal (no data) */
export interface WebhookV3CompletePayload {
  request_token: string;
  status: 'complete';
  record_id: string;
  record_type: 'complete';
  generated_at: string;
}

/** Error payload */
export interface WebhookV3ErrorPayload {
  request_token: string;
  status: 'error';
  record_id: string;
  record_type: 'error';
  generated_at: string;
  error: string;
}

export type AnyWebhookV3Payload =
  | WebhookV3Payload
  | WebhookV3CompletePayload
  | WebhookV3ErrorPayload;

// ---------------------------------------------------------------------------
// Record ID generation — deterministic for idempotency
// ---------------------------------------------------------------------------

/**
 * Generate a stable record_id from entity + record_type + discriminator.
 * Same inputs always produce the same ID for retry idempotency.
 */
export function generateRecordId(
  entityId: string,
  recordType: string,
  discriminator: string = ''
): string {
  const input = `${entityId}:${recordType}:${discriminator}`;
  const hash = crypto.createHash('md5').update(input).digest('hex').slice(0, 12);
  return `mt_${recordType.slice(0, 4)}_${hash}`;
}

// ---------------------------------------------------------------------------
// Entity builder — shared across all record types
// ---------------------------------------------------------------------------

interface EntityRow {
  entity_name: string;
  tid: string;
  tid_kind?: string;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip_code?: string | null;
  form_type?: string;
  signer_first_name?: string | null;
  signer_last_name?: string | null;
  gross_receipts?: Record<string, any> | null;
}

function buildEntityBlock(entity: EntityRow): WebhookV3Entity {
  // Derive entity_type from form_type
  const formType = (entity.form_type || '').toUpperCase().replace(/[\s-]/g, '');
  let entityType: string | null = null;
  if (formType === '1120S') entityType = 's_corporation';
  else if (formType === '1120') entityType = 'corporation';
  else if (formType === '1065') entityType = 'partnership';
  else if (formType === '1040') entityType = 'individual';
  else if (formType === 'W2_INCOME') entityType = 'individual';

  // Extract entity_transcript data for additional fields
  const entityTranscript = entity.gross_receipts?.entity_transcript;

  // Principal from signer info
  let principal: EntityPrincipal | null = null;
  if (entity.signer_first_name || entity.signer_last_name) {
    principal = {
      full_name: [entity.signer_first_name, entity.signer_last_name]
        .filter(Boolean)
        .join(' ') || null,
      title: null, // Not stored in current schema
    };
  }

  return {
    legal_name: entity.entity_name.toUpperCase(),
    submitted_name: entity.entity_name,
    ein: entity.tid,
    entity_type: entityType || entityTranscript?.entityType || null,
    state: entityTranscript?.stateOfFormation || entity.state || null,
    address: {
      street: entity.address || null,
      city: entity.city || null,
      state: entity.state || null,
      zip_code: entity.zip_code || null,
    },
    principal,
  };
}

// ---------------------------------------------------------------------------
// Record-type builders
// ---------------------------------------------------------------------------

/**
 * Build entity_profile record from BMF_ENTITY transcript data.
 */
export function buildEntityProfilePayload(
  requestToken: string,
  entity: EntityRow,
  entityData: Record<string, string> | null,
  rawHtml?: string
): WebhookV3Payload {
  const recordId = generateRecordId(entity.tid, 'entity_profile');
  const entityBlock = buildEntityBlock(entity);

  // Enrich entity block with entity transcript data
  if (entityData) {
    if (entityData.stateOfFormation) entityBlock.state = entityData.stateOfFormation;
  }

  const data: Record<string, unknown> = {};
  if (entityData) {
    if (entityData.filingRequirements) data.filing_requirements = entityData.filingRequirements;
    if (entityData.naicsCode) data.naics_code = entityData.naicsCode;
    if (entityData.establishmentDate) data.formation_date = entityData.establishmentDate;
    if (entityData.businessActivity) data.business_activity = entityData.businessActivity;
    if (entityData.registrationId) data.registration_id = entityData.registrationId;
    if (entityData.entityStatus) data.irs_status = entityData.entityStatus;
  }

  return {
    request_token: requestToken,
    status: 'partial',
    record_id: recordId,
    record_type: 'entity_profile',
    generated_at: new Date().toISOString(),
    entity: entityBlock,
    data,
    raw_html: rawHtml,
  };
}

/**
 * Build form_discovery record from entity transcript filing requirements.
 */
export function buildFormDiscoveryPayload(
  requestToken: string,
  entity: EntityRow,
  entityData: Record<string, string> | null,
  rawHtml?: string
): WebhookV3Payload | null {
  // Only generate if we have filing requirements data
  const filingReqs = entityData?.filingRequirements ||
    entity.gross_receipts?.entity_transcript?.filingRequirements;
  if (!filingReqs) return null;

  const recordId = generateRecordId(entity.tid, 'form_discovery');
  const entityBlock = buildEntityBlock(entity);

  // Parse filing requirements string into discovered forms
  // IRS format: "1120, 941, 940" or "Form 1120-S, Form 941"
  const discoveredForms: Array<{ form_type: string; status: string }> = [];
  const formMatches = filingReqs.match(/\d{3,4}[A-Z-]*/gi) || [];
  for (const form of formMatches) {
    discoveredForms.push({
      form_type: form.replace(/^Form\s*/i, '').trim(),
      status: 'filing_requirement_detected',
    });
  }

  return {
    request_token: requestToken,
    status: 'partial',
    record_id: recordId,
    record_type: 'form_discovery',
    generated_at: new Date().toISOString(),
    entity: entityBlock,
    data: {
      discovered_forms: discoveredForms,
      filing_requirements_raw: filingReqs,
      financial_verification_available: discoveredForms.some(
        f => ['1120', '1120S', '1065', '1040'].includes(f.form_type.replace('-', ''))
      ),
    },
    raw_html: rawHtml,
  };
}

/**
 * Build employment_compliance record from 941/940 transcript data.
 */
export function buildEmploymentCompliancePayload(
  requestToken: string,
  entity: EntityRow,
  formType: string,
  taxYear: string,
  complianceData: {
    severity?: string;
    flags?: Array<{ message: string; severity: string }>;
    financials?: Record<string, number | null>;
  } | null,
  rawHtml?: string
): WebhookV3Payload {
  const normalizedForm = formType.replace(/[\s-]/g, '');
  const quarter = taxYear.includes('-') ? parseQuarter(taxYear) : null;
  const year = parseInt(taxYear.match(/\d{4}/)?.[0] || '0', 10);

  const discriminator = `${normalizedForm}_${taxYear}`;
  const recordId = generateRecordId(entity.tid, 'employment_compliance', discriminator);
  const entityBlock = buildEntityBlock(entity);

  const data: Record<string, unknown> = {
    form_type: normalizedForm,
    year,
    status: complianceData?.severity === 'CRITICAL' ? 'delinquent' : 'current',
  };

  if (quarter) data.quarter = quarter;

  if (complianceData?.financials) {
    const fin = complianceData.financials;
    if (fin.totalTax != null) {
      data.total_tax_range_usd = { min: fin.totalTax, max: fin.totalTax };
    }
    if (fin.accountBalance != null) data.balance_due_usd = fin.accountBalance;
    if (fin.accruedInterest != null) data.accrued_interest_usd = fin.accruedInterest;
    if (fin.accruedPenalty != null) data.accrued_penalty_usd = fin.accruedPenalty;
  }

  if (complianceData?.flags && complianceData.flags.length > 0) {
    data.processing_notes = complianceData.flags.map(f => f.message);
  } else {
    data.processing_notes = [];
  }

  return {
    request_token: requestToken,
    status: 'partial',
    record_id: recordId,
    record_type: 'employment_compliance',
    generated_at: new Date().toISOString(),
    entity: entityBlock,
    data,
    raw_html: rawHtml,
  };
}

/**
 * Build financial_verification record from 1120/1120S/1065/1040 transcript data.
 */
export function buildFinancialVerificationPayload(
  requestToken: string,
  entity: EntityRow,
  formType: string,
  taxYear: string,
  complianceData: {
    severity?: string;
    flags?: Array<{ message: string; severity: string }>;
    financials?: Record<string, number | null>;
  } | null,
  rawHtml?: string
): WebhookV3Payload {
  const normalizedForm = formType.replace(/[\s-]/g, '');
  const year = parseInt(taxYear.match(/\d{4}/)?.[0] || '0', 10);

  const discriminator = `${normalizedForm}_${taxYear}`;
  const recordId = generateRecordId(entity.tid, 'financial_verification', discriminator);
  const entityBlock = buildEntityBlock(entity);

  const data: Record<string, unknown> = {
    reporting_year: year,
    form_type: normalizedForm,
    financial_verification_available: true,
  };

  if (complianceData?.financials) {
    const fin = complianceData.financials;
    const financials: Record<string, unknown> = {};

    if (fin.grossReceipts != null) {
      financials.revenue = { min_usd: fin.grossReceipts, max_usd: fin.grossReceipts };
    }
    if (fin.totalIncome != null) {
      financials.net_income = { min_usd: fin.totalIncome, max_usd: fin.totalIncome };
    }
    if (fin.totalDeductions != null) {
      financials.total_deductions = { min_usd: fin.totalDeductions, max_usd: fin.totalDeductions };
    }
    if (fin.totalTax != null) {
      financials.total_tax = { min_usd: fin.totalTax, max_usd: fin.totalTax };
    }
    if (fin.accountBalance != null) {
      financials.account_balance = fin.accountBalance;
    }

    data.financials = financials;
    data.confidence = computeConfidence(fin);
  }

  if (complianceData?.flags && complianceData.flags.length > 0) {
    data.processing_notes = complianceData.flags.map(f => f.message);
  }

  return {
    request_token: requestToken,
    status: 'partial',
    record_id: recordId,
    record_type: 'financial_verification',
    generated_at: new Date().toISOString(),
    entity: entityBlock,
    data,
    raw_html: rawHtml,
  };
}

/**
 * Build risk_signals record aggregated from all compliance data on the entity.
 */
export function buildRiskSignalsPayload(
  requestToken: string,
  entity: EntityRow,
  allGrossReceipts: Record<string, any> | null
): WebhookV3Payload {
  const recordId = generateRecordId(entity.tid, 'risk_signals', new Date().toISOString().slice(0, 10));
  const entityBlock = buildEntityBlock(entity);

  // Aggregate all compliance flags
  const signals: Array<{ category: string; severity: string; message: string }> = [];
  let worstSeverity: 'low' | 'medium' | 'high' = 'low';

  if (allGrossReceipts) {
    for (const [key, value] of Object.entries(allGrossReceipts)) {
      // Skip non-compliance keys
      if (key === 'entity_transcript' || key === 'entity_transcript_order') continue;
      if (!value || typeof value !== 'object') continue;

      const entry = value as { severity?: string; flags?: Array<{ message: string; severity: string }> };
      if (!entry.flags) continue;

      // Determine category from the key (e.g., "941_Quarterly_2025" → compliance)
      const category = key.includes('941') || key.includes('940')
        ? 'compliance'
        : 'financials';

      for (const flag of entry.flags) {
        signals.push({
          category,
          severity: flag.severity?.toLowerCase() === 'critical' ? 'high' : 'low',
          message: flag.message,
        });

        if (flag.severity?.toLowerCase() === 'critical') worstSeverity = 'high';
        else if (flag.severity?.toLowerCase() === 'warning' && worstSeverity === 'low') {
          worstSeverity = 'medium';
        }
      }
    }
  }

  // Compute overall risk score range based on signals
  const riskRange = computeRiskScore(signals, worstSeverity);

  return {
    request_token: requestToken,
    status: 'partial',
    record_id: recordId,
    record_type: 'risk_signals',
    generated_at: new Date().toISOString(),
    entity: entityBlock,
    data: {
      overall_risk_score_range: riskRange,
      rating: riskRange.max <= 30 ? 'LOW' : riskRange.max <= 60 ? 'MEDIUM' : 'HIGH',
      signals: signals.length > 0 ? signals : [
        {
          category: 'compliance',
          severity: 'low',
          message: 'No compliance issues detected.',
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Orchestrator — maps transcript type to v3 record types
// ---------------------------------------------------------------------------

export interface TranscriptUploadContext {
  requestToken: string;
  entity: EntityRow & { id: string; request_id: string };
  formType: string;         // e.g. "1120-S", "941", "BMF_ENTITY"
  taxYear: string;          // e.g. "2024", "09-30-2025"
  transcriptCategory?: 'income' | 'payroll' | 'entity';
  complianceData?: {
    severity?: string;
    flags?: Array<{ message: string; severity: string }>;
    financials?: Record<string, number | null>;
  } | null;
  entityData?: Record<string, string> | null;
  rawHtml?: string;
}

/**
 * Build all v3 payloads for a single transcript upload.
 * Returns 1-2 payloads depending on transcript type.
 */
export function buildV3PayloadsForUpload(ctx: TranscriptUploadContext): WebhookV3Payload[] {
  const payloads: WebhookV3Payload[] = [];
  const normalizedForm = ctx.formType.replace(/[\s-]/g, '').toUpperCase();

  if (normalizedForm === 'BMF_ENTITY' || ctx.transcriptCategory === 'entity') {
    // Entity transcript → entity_profile + form_discovery
    payloads.push(
      buildEntityProfilePayload(ctx.requestToken, ctx.entity, ctx.entityData || null, ctx.rawHtml)
    );

    const formDiscovery = buildFormDiscoveryPayload(
      ctx.requestToken, ctx.entity, ctx.entityData || null, ctx.rawHtml
    );
    if (formDiscovery) payloads.push(formDiscovery);

  } else if (['941', '940'].includes(normalizedForm) || ctx.transcriptCategory === 'payroll') {
    // Payroll transcript → employment_compliance
    payloads.push(
      buildEmploymentCompliancePayload(
        ctx.requestToken, ctx.entity, ctx.formType, ctx.taxYear,
        ctx.complianceData || null, ctx.rawHtml
      )
    );

  } else {
    // Income/financial transcript (1120, 1120S, 1065, 1040) → financial_verification
    payloads.push(
      buildFinancialVerificationPayload(
        ctx.requestToken, ctx.entity, ctx.formType, ctx.taxYear,
        ctx.complianceData || null, ctx.rawHtml
      )
    );
  }

  return payloads;
}

/**
 * Build a completion payload with aggregated risk signals.
 * Sent when all entities in a request are completed.
 */
export function buildV3CompletionPayloads(
  requestToken: string,
  entities: Array<EntityRow & { id: string; gross_receipts: Record<string, any> | null }>
): AnyWebhookV3Payload[] {
  const payloads: AnyWebhookV3Payload[] = [];

  // Send risk_signals for each entity
  for (const entity of entities) {
    payloads.push(
      buildRiskSignalsPayload(requestToken, entity, entity.gross_receipts)
    );
  }

  // Send lightweight "complete" signal
  payloads.push({
    request_token: requestToken,
    status: 'complete' as const,
    record_id: `mt_complete_${crypto.createHash('md5').update(requestToken).digest('hex').slice(0, 12)}`,
    record_type: 'complete' as any,
    generated_at: new Date().toISOString(),
  });

  return payloads;
}

// ---------------------------------------------------------------------------
// Delivery integration
// ---------------------------------------------------------------------------

/**
 * Trigger v3 structured webhooks for a transcript upload.
 * Called from batch-upload after storing the file.
 * Enqueues one delivery per record_type payload.
 */
export async function triggerV3Webhook(
  supabase: SupabaseClient,
  ctx: TranscriptUploadContext
): Promise<string[]> {
  // Fetch request to get external_request_token and client webhook config
  const { data: req } = await supabase
    .from('requests')
    .select('id, client_id, intake_method, external_request_token, status')
    .eq('id', ctx.entity.request_id)
    .single();

  if (!req || req.intake_method !== 'api' || !req.external_request_token) {
    return [];
  }

  // Check client webhook URL and version preference
  const { data: client } = await supabase
    .from('clients')
    .select('id, webhook_url, webhook_secret')
    .eq('id', req.client_id)
    .single();

  if (!client?.webhook_url) {
    return [];
  }

  // Override request_token with the external token
  ctx.requestToken = req.external_request_token;

  // Build all v3 payloads for this upload
  const payloads = buildV3PayloadsForUpload(ctx);
  const deliveryIds: string[] = [];

  for (const payload of payloads) {
    // Enqueue delivery
    const { data: delivery, error: insertError } = await supabase
      .from('webhook_deliveries')
      .insert({
        request_id: ctx.entity.request_id,
        client_id: client.id,
        webhook_url: client.webhook_url,
        payload: payload as any,
        status: 'pending',
        max_attempts: 5,
      })
      .select('id')
      .single();

    if (insertError || !delivery) {
      console.error(`[webhook-v3] Failed to enqueue ${payload.record_type}:`, insertError);
      continue;
    }

    console.log(`[webhook-v3] Enqueued ${delivery.id} → ${payload.record_type} (${payload.record_id})`);
    deliveryIds.push(delivery.id);

    // Deliver immediately (awaited for serverless safety)
    const { deliverWebhook } = await import('./webhook');
    try {
      await deliverWebhook(supabase, delivery.id);
    } catch (err) {
      console.error(`[webhook-v3] Delivery failed for ${delivery.id}:`, err);
    }
  }

  return deliveryIds;
}

/**
 * Trigger v3 completion webhooks (risk_signals + complete) for a finished request.
 * Called from auto-complete cron when all entities are done.
 */
export async function triggerV3CompletionWebhook(
  supabase: SupabaseClient,
  requestId: string
): Promise<string[]> {
  const { data: req } = await supabase
    .from('requests')
    .select('id, client_id, intake_method, external_request_token')
    .eq('id', requestId)
    .single();

  if (!req || req.intake_method !== 'api' || !req.external_request_token) {
    return [];
  }

  const { data: client } = await supabase
    .from('clients')
    .select('id, webhook_url')
    .eq('id', req.client_id)
    .single();

  if (!client?.webhook_url) {
    return [];
  }

  // Fetch all entities for the request
  const { data: entities } = await supabase
    .from('request_entities')
    .select('id, entity_name, tid, tid_kind, address, city, state, zip_code, form_type, signer_first_name, signer_last_name, gross_receipts')
    .eq('request_id', requestId) as { data: any[] | null; error: any };

  if (!entities || entities.length === 0) return [];

  const payloads = buildV3CompletionPayloads(req.external_request_token, entities);
  const deliveryIds: string[] = [];

  for (const payload of payloads) {
    const { data: delivery, error: insertError } = await supabase
      .from('webhook_deliveries')
      .insert({
        request_id: requestId,
        client_id: client.id,
        webhook_url: client.webhook_url,
        payload: payload as any,
        status: 'pending',
        max_attempts: 5,
      })
      .select('id')
      .single();

    if (insertError || !delivery) {
      console.error(`[webhook-v3] Failed to enqueue completion payload:`, insertError);
      continue;
    }

    deliveryIds.push(delivery.id);

    const { deliverWebhook } = await import('./webhook');
    try {
      await deliverWebhook(supabase, delivery.id);
    } catch (err) {
      console.error(`[webhook-v3] Completion delivery failed:`, err);
    }
  }

  return deliveryIds;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse quarter from IRS date format "MM-DD-YYYY" → "Q1" etc. */
function parseQuarter(dateStr: string): string | null {
  const match = dateStr.match(/^(\d{2})-/);
  if (!match) return null;
  const month = parseInt(match[1], 10);
  if (month <= 3) return 'Q1';
  if (month <= 6) return 'Q2';
  if (month <= 9) return 'Q3';
  return 'Q4';
}

/** Compute confidence score (0-1) based on how many financial fields are present */
function computeConfidence(financials: Record<string, number | null>): number {
  const fields = ['grossReceipts', 'totalIncome', 'totalDeductions', 'totalTax', 'accountBalance'];
  const present = fields.filter(f => financials[f] != null).length;
  return Math.round((present / fields.length) * 100) / 100;
}

/** Compute risk score range from signals */
function computeRiskScore(
  signals: Array<{ severity: string }>,
  worstSeverity: 'low' | 'medium' | 'high'
): { min: number; max: number } {
  if (worstSeverity === 'high') return { min: 60, max: 85 };
  if (worstSeverity === 'medium') return { min: 30, max: 55 };
  // Low or no signals
  const highCount = signals.filter(s => s.severity === 'high').length;
  if (highCount > 0) return { min: 50, max: 70 };
  return { min: 10, max: 30 };
}
