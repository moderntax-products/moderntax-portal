/**
 * Trial activation helpers — called from the Stripe webhook when a
 * trial client captures a card, and from the auto-convert flow.
 *
 * Extracted so the webhook, /trial-activate page callback, and any
 * admin-trigger path all use the same write path.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logFunnelEvent } from './funnel-events';

/**
 * Stamp trial_card_captured_at + trial_started_at + trial_expires_at.
 * Idempotent via trial_card_captured_at IS NULL guard.
 */
export async function activateTrial(
  admin: SupabaseClient,
  clientId: string,
  userId: string | null,
): Promise<{ already_active: boolean }> {
  const { data: client } = await (admin.from('clients') as any)
    .select('trial_card_captured_at, trial_entities_allowed')
    .eq('id', clientId).single();

  if (client?.trial_card_captured_at) return { already_active: true };

  const now = new Date();
  const expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const { error } = await (admin.from('clients') as any).update({
    trial_card_captured_at: now.toISOString(),
    trial_started_at: now.toISOString(),
    trial_expires_at: expires.toISOString(),
    trial_entities_allowed: Math.max(client?.trial_entities_allowed ?? 0, 1),
  }).eq('id', clientId);

  if (error) throw new Error('Failed to activate trial: ' + error.message);

  await logFunnelEvent(admin, 'card_captured', clientId, userId, {
    trial_started_at: now.toISOString(),
    trial_expires_at: expires.toISOString(),
  });

  return { already_active: false };
}

/**
 * Mark trial as converted after first auto-charge succeeds.
 */
export async function convertTrial(
  admin: SupabaseClient,
  clientId: string,
  userId: string | null,
  stripePaymentIntentId: string,
  amountCents: number,
): Promise<void> {
  const now = new Date().toISOString();
  await (admin.from('clients') as any).update({ trial_converted_at: now }).eq('id', clientId);

  await logFunnelEvent(admin, 'trial_converted', clientId, userId, {
    converted_by: 'stripe_auto',
    stripe_payment_intent_id: stripePaymentIntentId,
    amount_cents: amountCents,
    converted_at: now,
  });
}
