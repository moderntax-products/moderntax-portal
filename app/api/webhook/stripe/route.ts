/**
 * POST /api/webhook/stripe
 *
 * Stripe webhook receiver. Verifies signature with STRIPE_WEBHOOK_SECRET,
 * then dispatches on event.type.
 *
 * Events handled:
 *   - checkout.session.completed     → PRIMARY save path for the new Checkout
 *                                      Session flow. Retrieves the SetupIntent
 *                                      attached to the session, persists the
 *                                      PaymentMethod to clients.
 *   - setup_intent.succeeded         → backup save path (also fires alongside
 *                                      checkout.session.completed). Idempotent
 *                                      with the checkout handler.
 *   - payment_method.attached        → mirror to clients table (sometimes the
 *                                      attach happens via a flow other than our
 *                                      save endpoints).
 *   - payment_method.detached        → mark payment_method_status='detached' so
 *                                      the order gate kicks back in.
 *   - payment_intent.succeeded       → mark the matching invoice as paid_via=stripe.
 *   - payment_intent.payment_failed  → flag the invoice + email admin.
 *
 * Configure in Stripe Dashboard:
 *   Endpoint URL: https://portal.moderntax.io/api/webhook/stripe
 *   Events:       setup_intent.succeeded, payment_method.attached,
 *                 payment_method.detached, payment_intent.succeeded,
 *                 payment_intent.payment_failed
 *   Set the signing secret as STRIPE_WEBHOOK_SECRET in Vercel env.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { createAdminClient } from '@/lib/supabase-server';
import type Stripe from 'stripe';

// Stripe sends a raw body which must NOT be parsed by Next.js before
// signature verification. The route reads the body as text directly.
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const sig = request.headers.get('stripe-signature') || '';
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET not set — rejecting');
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });
  }

  const rawBody = await request.text();
  const stripe = getStripe();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, secret);
  } catch (err) {
    console.error('[stripe-webhook] Signature verification failed:', err);
    return NextResponse.json({ error: 'Bad signature' }, { status: 400 });
  }

  const admin = createAdminClient();

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;

        // Tier upgrade flow (mode=payment for Tier B, mode=subscription for
        // Tier C). On success, flip the client's billing_model + rates
        // so the next auto-invoice run uses the new tier.
        if (session.metadata?.flow === 'tier_upgrade') {
          const clientId = session.metadata.moderntax_client_id;
          const targetTier = session.metadata.target_tier;
          if (!clientId) {
            console.warn('[stripe-webhook] tier_upgrade without client_id metadata');
            break;
          }
          const today = new Date().toISOString().split('T')[0];
          let billingUpdate: Record<string, any> = {};
          if (targetTier === 'B') {
            billingUpdate = {
              billing_model: 'per_tin',
              billing_rate_pdf: 59.98,
              billing_rate_csv: 59.98,
              billing_effective_from: today,
              free_trial: false,
            };
          } else if (targetTier === 'C') {
            billingUpdate = {
              billing_model: 'subscription',
              subscription_monthly_amount: 2500,
              subscription_included_entities: 50,
              subscription_overage_rate: 39.99,
              billing_rate_pdf: 39.99,
              billing_rate_csv: 39.99,
              billing_effective_from: today,
              free_trial: false,
            };
          }
          // Append a closure note to billing_notes so admin can audit.
          const { data: existing } = await admin
            .from('clients')
            .select('billing_notes')
            .eq('id', clientId)
            .single() as { data: { billing_notes: string | null } | null };
          const upgradeNote = `[${today}] Self-serve upgrade to Tier ${targetTier} via Stripe Checkout (session=${session.id}, amount=$${(session.amount_total || 0) / 100}). Billing rates updated automatically.`;
          billingUpdate.billing_notes = existing?.billing_notes
            ? `${existing.billing_notes}\n\n${upgradeNote}`
            : upgradeNote;

          const { error: upErr } = await (admin
            .from('clients') as any)
            .update(billingUpdate)
            .eq('id', clientId);
          if (upErr) {
            console.error(`[stripe-webhook] tier_upgrade DB update failed for ${clientId}:`, upErr.message);
          } else {
            console.log(`[stripe-webhook] Tier ${targetTier} applied to client ${clientId}`);
          }
          break;
        }

        // -------------------------------------------------------------------
        // Check Reissue Service ($1,000) — premium recovery service
        // -------------------------------------------------------------------
        // Started by an admin clicking "Request Check Reissue" on the ERC
        // report. /api/billing/purchase creates the Stripe Checkout session;
        // this handler flips payment_status to 'paid' so the admin queue
        // can start the actual work (Form 8822-B + IRS reissuance call).
        if (session.metadata?.flow === 'check_reissue') {
          const checkReissueId = session.metadata.check_reissue_id;
          if (!checkReissueId) {
            console.warn('[stripe-webhook] check_reissue without check_reissue_id metadata');
            break;
          }
          const paymentIntentId = typeof session.payment_intent === 'string'
            ? session.payment_intent
            : session.payment_intent?.id;
          const { error: upErr } = await (admin
            .from('check_reissue_requests' as any) as any)
            .update({
              payment_status: 'paid',
              paid_at: new Date().toISOString(),
              stripe_payment_intent_id: paymentIntentId || null,
              billed_at: new Date().toISOString(),
            })
            .eq('id', checkReissueId);
          if (upErr) {
            console.error(`[stripe-webhook] check_reissue payment update failed for ${checkReissueId}:`, upErr.message);
          } else {
            console.log(`[stripe-webhook] check_reissue ${checkReissueId} marked paid (amount=$${(session.amount_total || 0) / 100})`);
          }
          break;
        }

        // -------------------------------------------------------------------
        // ERC Full-Sweep Premium ($79.98) — per-entity upgrade
        // -------------------------------------------------------------------
        // Flips erc_full_sweep_paid=true on the entity. Expert sees the
        // upgrade marker and pulls all 6–7 eligible ERC quarters instead
        // of the base 3.
        if (session.metadata?.flow === 'erc_full_sweep') {
          const entityId = session.metadata.entity_id;
          if (!entityId) {
            console.warn('[stripe-webhook] erc_full_sweep without entity_id metadata');
            break;
          }
          const paymentIntentId = typeof session.payment_intent === 'string'
            ? session.payment_intent
            : session.payment_intent?.id;
          const { error: upErr } = await (admin
            .from('request_entities') as any)
            .update({
              erc_full_sweep_paid: true,
              erc_full_sweep_paid_at: new Date().toISOString(),
              erc_full_sweep_payment_intent_id: paymentIntentId || null,
            })
            .eq('id', entityId);
          if (upErr) {
            console.error(`[stripe-webhook] erc_full_sweep update failed for ${entityId}:`, upErr.message);
          } else {
            console.log(`[stripe-webhook] erc_full_sweep paid on entity ${entityId} (amount=$${(session.amount_total || 0) / 100})`);
          }
          break;
        }

        // PRIMARY save path for the Checkout Session flow (payment-method
        // attach via mode=setup). Retrieve the SetupIntent → its payment_method
        // → persist to clients.
        if (session.mode !== 'setup') break;
        const clientId = session.metadata?.moderntax_client_id;
        if (!clientId) {
          console.warn('[stripe-webhook] checkout.session.completed without moderntax_client_id metadata');
          break;
        }
        const setupIntentId = typeof session.setup_intent === 'string'
          ? session.setup_intent
          : session.setup_intent?.id;
        if (!setupIntentId) break;

        const stripe = getStripe();
        // Expand `payment_method` so we get the brand / last4 in one call
        // instead of two — saves a round trip and a billing nickel.
        const si = await stripe.setupIntents.retrieve(setupIntentId, {
          expand: ['payment_method'],
        });
        const pm = si.payment_method as Stripe.PaymentMethod | null;
        if (!pm || typeof pm === 'string') {
          console.warn(`[stripe-webhook] checkout.session.completed — SetupIntent ${si.id} has no expanded payment_method`);
          break;
        }

        // Set as customer's invoice default so future PaymentIntents (add-on
        // purchases, monitoring upsells, tier upgrades) pick it up automatically.
        if (typeof si.customer === 'string') {
          await stripe.customers.update(si.customer, {
            invoice_settings: { default_payment_method: pm.id },
          });
        }

        const last4 = pm.card?.last4 || pm.us_bank_account?.last4 || null;
        const brand = pm.card?.brand || pm.us_bank_account?.bank_name || null;

        await (admin
          .from('clients') as any)
          .update({
            stripe_payment_method_id: pm.id,
            payment_method_type: pm.type,
            payment_method_brand: brand,
            payment_method_last4: last4,
            payment_method_attached_at: new Date().toISOString(),
            payment_method_status: 'active',
          })
          .eq('id', clientId);

        console.log(`[stripe-webhook] checkout.session.completed — client ${clientId} now has ${pm.type} ${brand} ····${last4}`);
        break;
      }

      case 'setup_intent.succeeded': {
        const si = event.data.object as Stripe.SetupIntent;
        const clientId = si.metadata?.moderntax_client_id;
        console.log(`[stripe-webhook] setup_intent.succeeded — client=${clientId} pm=${si.payment_method}`);
        // Backup save path — fires alongside checkout.session.completed for
        // Checkout flows. The checkout handler above does the same write but
        // earlier; this is idempotent (we only set fields, never clear them).
        if (clientId && si.payment_method && typeof si.payment_method === 'string') {
          const stripe = getStripe();
          const pm = await stripe.paymentMethods.retrieve(si.payment_method);
          const last4 = pm.card?.last4 || pm.us_bank_account?.last4 || null;
          const brand = pm.card?.brand || pm.us_bank_account?.bank_name || null;

          // Only set if the checkout handler didn't already persist (avoid
          // overwriting a method the user just changed via another flow).
          const { data: existing } = await admin
            .from('clients')
            .select('stripe_payment_method_id')
            .eq('id', clientId)
            .single() as { data: { stripe_payment_method_id: string | null } | null };
          if (!existing?.stripe_payment_method_id || existing.stripe_payment_method_id !== pm.id) {
            await (admin
              .from('clients') as any)
              .update({
                stripe_payment_method_id: pm.id,
                payment_method_type: pm.type,
                payment_method_brand: brand,
                payment_method_last4: last4,
                payment_method_attached_at: new Date().toISOString(),
                payment_method_status: 'active',
              })
              .eq('id', clientId);
          }
        }
        break;
      }

      case 'payment_method.attached': {
        const pm = event.data.object as Stripe.PaymentMethod;
        if (!pm.customer) break;
        // Find the client by Stripe customer id and update fields if not already set.
        const customerId = typeof pm.customer === 'string' ? pm.customer : pm.customer.id;
        const { data: client } = await admin
          .from('clients')
          .select('id, stripe_payment_method_id')
          .eq('stripe_customer_id', customerId)
          .single() as { data: any };
        if (!client) break;
        // Only set if no method on file — the save endpoint handles the
        // happy path; this is for out-of-band attachments (e.g. Stripe Dashboard).
        if (!client.stripe_payment_method_id) {
          const last4 = pm.card?.last4 || pm.us_bank_account?.last4 || null;
          const brand = pm.card?.brand || pm.us_bank_account?.bank_name || null;
          await (admin
            .from('clients') as any)
            .update({
              stripe_payment_method_id: pm.id,
              payment_method_type: pm.type,
              payment_method_brand: brand,
              payment_method_last4: last4,
              payment_method_attached_at: new Date().toISOString(),
              payment_method_status: 'active',
            })
            .eq('id', client.id);
          console.log(`[stripe-webhook] payment_method.attached — backfilled client ${client.id}`);
        }
        break;
      }

      case 'payment_method.detached': {
        const pm = event.data.object as Stripe.PaymentMethod;
        const { data: client } = await admin
          .from('clients')
          .select('id')
          .eq('stripe_payment_method_id', pm.id)
          .maybeSingle() as { data: any };
        if (client) {
          await (admin
            .from('clients') as any)
            .update({
              payment_method_status: 'detached',
            })
            .eq('id', client.id);
          console.log(`[stripe-webhook] payment_method.detached — client ${client.id} now requires re-attach`);
        }
        break;
      }

      case 'payment_intent.succeeded': {
        const pi = event.data.object as Stripe.PaymentIntent;
        const invoiceId = pi.metadata?.moderntax_invoice_id;
        if (invoiceId) {
          await (admin
            .from('invoices') as any)
            .update({
              status: 'paid',
              stripe_payment_intent_id: pi.id,
              stripe_charge_id: typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge?.id || null,
              paid_via: 'stripe',
              paid_at: new Date().toISOString(),
            })
            .eq('id', invoiceId);
          console.log(`[stripe-webhook] payment_intent.succeeded — invoice ${invoiceId} marked paid`);
        }
        break;
      }

      case 'payment_intent.payment_failed': {
        const pi = event.data.object as Stripe.PaymentIntent;
        const invoiceId = pi.metadata?.moderntax_invoice_id;
        const lastError = pi.last_payment_error?.message || 'unknown';
        console.error(`[stripe-webhook] payment_intent.payment_failed — invoice=${invoiceId} reason=${lastError}`);
        if (invoiceId) {
          await (admin
            .from('invoices') as any)
            .update({
              status: 'payment_failed',
              stripe_payment_intent_id: pi.id,
            })
            .eq('id', invoiceId);
        }
        // TODO: trigger email to manager + matt@moderntax.io
        break;
      }

      default:
        // Unhandled events are fine — Stripe sends many; we only act on what we declared.
        break;
    }
  } catch (err) {
    console.error('[stripe-webhook] handler error:', err);
    // Return 200 anyway so Stripe doesn't retry — we logged the error.
    return NextResponse.json({ received: true, handler_error: true });
  }

  return NextResponse.json({ received: true });
}
