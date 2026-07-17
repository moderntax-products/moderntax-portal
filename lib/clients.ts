/**
 * Client Configuration and Utilities
 * Maps domains to clients for auto-provisioning on first login
 */

import type { Client } from './types';

// Billing rates
// Entity transcript is free as of 2026-07-17 (no-charge verification on every order).
export const RATE_ENTITY_TRANSCRIPT = 0;

/**
 * Client configuration database
 * Maps email domains to client metadata for auto-provisioning
 */
export const CLIENT_CONFIG: Record<string, Omit<Client, 'id' | 'created_at' | 'updated_at'>> = {
  'teamcenterstone.com': {
    name: 'Centerstone SBA Lending',
    slug: 'centerstone',
    domain: 'teamcenterstone.com',
    logo_url: 'https://cdn.moderntax.io/clients/centerstone-logo.png',
    intake_methods: ['csv', 'manual'],
    transcript_format: 'pdf',
    api_key: null,
    api_request_limit: null,
    webhook_url: null,
    webhook_secret: null,
    billing_payment_method: null,
    billing_ap_email: null,
    billing_ap_phone: null,
    billing_rate_pdf: 59.98,
    billing_rate_csv: 69.98,
  },
  'tmcfinancing.com': {
    name: 'TMC Financing',
    slug: 'tmc',
    domain: 'tmcfinancing.com',
    logo_url: 'https://cdn.moderntax.io/clients/tmc-logo.png',
    intake_methods: ['pdf', 'manual'],
    transcript_format: 'pdf',
    api_key: null,
    api_request_limit: null,
    webhook_url: null,
    webhook_secret: null,
    billing_payment_method: null,
    billing_ap_email: null,
    billing_ap_phone: null,
    billing_rate_pdf: 59.98,
    billing_rate_csv: 69.98,
  },
  'clearfirm.com': {
    name: 'Clearfirm',
    slug: 'clearfirm',
    domain: 'clearfirm.com',
    logo_url: 'https://cdn.moderntax.io/clients/clearfirm-logo.png',
    intake_methods: ['csv', 'pdf', 'manual', 'api'],
    transcript_format: 'html',
    // SOC 2 CR-1 (MOD-223) — API key removed from source. Auth happens via
    // SHA-256 hash lookup in clients.api_key_hash (see lib/auth-util.ts).
    // The prior literal `mt_live_txn_clearfirm_2026Q1` MUST be rotated
    // out-of-band: generate new key, store hash in DB, communicate new key
    // to Clearfirm via secure channel. Old key remains valid until rotation.
    api_key: null,
    api_request_limit: null,
    webhook_url: 'https://clearfirm-api.onrender.com/api/v1/webhook/moderntax',
    webhook_secret: null,
    billing_payment_method: null,
    billing_ap_email: null,
    billing_ap_phone: null,
    billing_rate_pdf: 59.98,
    billing_rate_csv: 69.98,
  },
};

/**
 * Get client slug from email domain
 * Extracts domain from email and looks up client configuration
 */
export function getClientSlugFromEmail(email: string): string | null {
  const domain = email.split('@')[1];
  if (!domain) return null;

  return CLIENT_CONFIG[domain]?.slug || null;
}

/**
 * Get client config from email domain
 * Returns client metadata if email domain is recognized
 */
export function getClientConfigFromEmail(
  email: string
): (Omit<Client, 'id' | 'created_at' | 'updated_at'> & { slug: string }) | null {
  const domain = email.split('@')[1];
  if (!domain) return null;

  const config = CLIENT_CONFIG[domain];
  return config ? { ...config, slug: config.slug } : null;
}

/**
 * Check if domain is a recognized client domain
 */
export function isRecognizedClientDomain(domain: string): boolean {
  return domain in CLIENT_CONFIG;
}

/**
 * Get all configured client slugs
 */
export function getAllClientSlugs(): string[] {
  return Object.values(CLIENT_CONFIG).map((config) => config.slug);
}

/**
 * Get all configured clients
 */
export function getAllClients(): (Omit<Client, 'id' | 'created_at' | 'updated_at'> & {
  slug: string;
})[] {
  return Object.values(CLIENT_CONFIG).map((config) => ({
    ...config,
    slug: config.slug,
  }));
}

/**
 * Validate user can access a specific client
 * Checks if user's email domain matches client configuration
 */
export function validateUserClientAccess(email: string, clientSlug: string): boolean {
  const userClientSlug = getClientSlugFromEmail(email);
  return userClientSlug === clientSlug;
}

// SOC 2 CC6.2/CC6.3 — `inferUserRole()` was deleted because the
// `@moderntax.io → admin` default was a silent privilege-escalation
// landmine for any future signup-flow refactor that imported it. Role
// assignment is now exclusively explicit at admin-approval time.
