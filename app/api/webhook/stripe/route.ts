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

        // -------------------------------------------------------------------
        // Prepaid credit purchase ($1,000 → 40% off, $2,000 → 60% off)
        // -------------------------------------------------------------------
        // Adds the pack amount to the client's credit wallet, locks in the
        // discounted per-request rate, and persists the card as the
        // required card-on-file. Idempotent via credit_ledger.stripe_ref.
        if (session.metadata?.flow === 'credit_purchase') {
          const clientId = session.metadata.client_id;
          const amount = Number(session.metadata.pack_amount) || (session.amount_total || 0) / 100;
          const packRate = Number(session.metadata.pack_rate) || 99.99;
          if (!clientId) { console.warn('[stripe-webhook] credit_purchase without client_id'); break; }

          const { data: already } = await (admin.from('credit_ledger' as any) as any)
            .select('id').eq('stripe_ref', session.id).maybeSingle();
          if (already) { console.log(`[stripe-webhook] credit_purchase ${session.id} already processed`); break; }

          const { data: c } = await admin.from('clients')
            .select('credit_balance, credit_rate, credit_purchased_total').eq('id', clientId).single() as { data: any };
          const newBalance = (Number(c?.credit_balance) || 0) + amount;
          const newRate = Math.min(Number(c?.credit_rate) > 0 ? Number(c.credit_rate) : 99.99, packRate);
          const newTotal = (Number(c?.credit_purchased_total) || 0) + amount;

          // Persist the card on file (saved via setup_future_usage on the PI).
          const stripe = getStripe();
          const piId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
          const pmUpdate: Record<string, any> = {};
          if (piId) {
            try {
              const pi = await stripe.paymentIntents.retrieve(piId, { expand: ['payment_method'] });
              const pm = pi.payment_method as Stripe.PaymentMethod | null;
              if (pm && typeof pm !== 'string') {
                pmUpdate.stripe_payment_method_id = pm.id;
                pmUpdate.payment_method_type = pm.type;
                pmUpdate.payment_method_brand = pm.card?.brand || pm.us_bank_account?.bank_name || null;
                pmUpdate.payment_method_last4 = pm.card?.last4 || pm.us_bank_account?.last4 || null;
                pmUpdate.payment_method_attached_at = new Date().toISOString();
                pmUpdate.payment_method_status = 'active';
                if (typeof pi.customer === 'string') {
                  await stripe.customers.update(pi.customer, { invoice_settings: { default_payment_method: pm.id } });
                }
              }
            } catch (e) { console.warn('[stripe-webhook] credit_purchase PM persist failed:', e); }
          }

          const { error: upErr } = await (admin.from('clients') as any)
            .update({ credit_balance: newBalance, credit_rate: newRate, credit_purchased_total: newTotal, ...pmUpdate })
            .eq('id', clientId);
          if (upErr) { console.error(`[stripe-webhook] credit_purchase wallet update failed for ${clientId}:`, upErr.message); break; }

          await (admin.from('credit_ledger' as any) as any).insert({
            client_id: clientId, kind: 'purchase', amount, balance_after: newBalance,
            stripe_ref: session.id, note: `${session.metadata.pack} purchase`,
          });
          console.log(`[stripe-webhook] credit_purchase: +$${amount} to ${clientId} → balance $${newBalance}, rate $${newRate}`);
          break;
        }

        // -------------------------------------------------------------------
        // ModernTax Direct back-year filing fee ($50 × years, less account
        // credit). On success: mark the entity's fee paid, draw down the
        // client's credit_balance by the credit applied, and append to the
        // entity's payment ledger so additional Direct payments (state filing,
        // etc.) accumulate over the engagement. Idempotent via the ledger's
        // stripe_ref = session.id.
        // -------------------------------------------------------------------
        if (session.metadata?.flow === 'backyear_filing') {
          const entityId = session.metadata.entity_id;
          if (!entityId) { console.warn('[stripe-webhook] backyear_filing without entity_id'); break; }
          const amountPaid = (session.amount_total || 0) / 100;
          const creditApplied = Number(session.metadata.credit_applied) || 0;
          // Prepay (deposit before work) vs. post-completion fee, and the rush upgrade.
          const isPrepay = session.metadata.prepay === '1';
          const isExpedited = session.metadata.expedited === 'true';
          const rushFee = Number(session.metadata.rush_fee) || 0;
          const nowIso = new Date().toISOString();

          const { data: already } = await (admin.from('credit_ledger' as any) as any)
            .select('id').eq('stripe_ref', session.id).maybeSingle();
          if (already) { console.log(`[stripe-webhook] backyear_filing ${session.id} already processed`); break; }

          const { data: ent } = await admin.from('request_entities')
            .select('gross_receipts, requests!inner(client_id)').eq('id', entityId).single() as { data: any };
          const clientId = ent?.requests?.client_id || null;
          const gr = ent?.gross_receipts || {};
          const payments = Array.isArray(gr.payments) ? gr.payments : [];
          payments.push({
            kind: isPrepay ? 'backyear_filing_prepay' : 'backyear_filing',
            amount: amountPaid, credit_applied: creditApplied,
            years_filed: Number(session.metadata.years_filed) || null,
            expedited: isExpedited, rush_fee: rushFee,
            stripe_ref: session.id, paid_at: nowIso,
          });
          const newGr = {
            ...gr,
            filing: {
              ...(gr.filing || {}),
              // Prepay records a deposit; post-completion records the final fee.
              ...(isPrepay
                ? { prepaid: true, prepaid_at: nowIso, prepaid_amount: amountPaid }
                : { fee_paid: true, fee_paid_at: nowIso, fee_paid_amount: amountPaid }),
              // Rush upgrade → priority expert assignment + tighter SLA downstream.
              ...(isExpedited ? { rush: true, rush_paid_at: nowIso, rush_fee: rushFee } : {}),
            },
            payments,
          };
          await (admin.from('request_entities') as any).update({ gross_receipts: newGr }).eq('id', entityId);

          let balanceAfter: number | null = null;
          if (clientId && creditApplied > 0) {
            const { data: c } = await admin.from('clients').select('credit_balance').eq('id', clientId).single() as { data: any };
            balanceAfter = Math.max(0, (Number(c?.credit_balance) || 0) - creditApplied);
            await (admin.from('clients') as any).update({ credit_balance: balanceAfter }).eq('id', clientId);
            await (admin.from('credit_ledger' as any) as any).insert({
              client_id: clientId, kind: 'redemption', amount: -creditApplied, balance_after: balanceAfter,
              stripe_ref: `${session.id}:credit`, note: 'Account credit applied to filing fee',
            });
          }
          await (admin.from('credit_ledger' as any) as any).insert({
            client_id: clientId, kind: 'filing_fee', amount: amountPaid, balance_after: balanceAfter,
            stripe_ref: session.id,
            note: `${isPrepay ? 'Back-year filing prepay' : 'Back-year filing fee'}${isExpedited ? ' (expedited)' : ''} — ${session.metadata.years_filed || '?'} yrs (entity ${entityId.slice(0, 8)})`,
          });
          console.log(`[stripe-webhook] backyear_filing${isPrepay ? ' prepay' : ''}${isExpedited ? ' expedited' : ''}: paid $${amountPaid} (credit $${creditApplied}) for entity ${entityId}`);
          break;
        }

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
        // Self-Serve Pack ($239.94 / $379.99 / $159.96 / $1,000)
        // -------------------------------------------------------------------
        // Anonymous purchase from /sample-transcripts/erc-report. No
        // existing client/user record. Email matt@moderntax.io with the
        // purchase context so he can onboard them off-platform within
        // 24 hours: create the clients + profiles rows, send a magic-
        // link signup email, and chase the EINs they want pulled.
        if (session.metadata?.flow === 'self_serve') {
          const stripe = getStripe();
          // Pull the customer record so we have an email + name to send to.
          let customerEmail: string | null = session.customer_details?.email || null;
          let customerName:  string | null = session.customer_details?.name  || null;
          let companyName:   string | null = null; // built from the billing address below if present

          if (!customerEmail && typeof session.customer === 'string') {
            try {
              const cust = await stripe.customers.retrieve(session.customer);
              if (cust && !cust.deleted) {
                customerEmail = cust.email || customerEmail;
                customerName = cust.name || customerName;
              }
            } catch (custErr) {
              console.warn('[stripe-webhook] self_serve: customer retrieve failed:', custErr);
            }
          }

          const pack = session.metadata.pack || '(unknown)';
          const packName = session.metadata.pack_name || pack;
          const packQty  = session.metadata.pack_quantity || '1';
          const amountUsd = (session.amount_total || 0) / 100;

          const billingAddr = (session.customer_details as any)?.address;
          if (billingAddr?.line1) {
            companyName = `${billingAddr.line1}${billingAddr.line2 ? ', ' + billingAddr.line2 : ''}, ${billingAddr.city || ''} ${billingAddr.state || ''} ${billingAddr.postal_code || ''}`.replace(/\s+/g, ' ').trim();
          }

          // Best-effort SendGrid notify — failure shouldn't 500 the webhook
          // since Stripe will retry on non-2xx (and we don't want the
          // payment confirmation to be re-sent because of an email blip).
          try {
            const sgMail = (await import('@sendgrid/mail')).default;
            const sgKey = process.env.SENDGRID_API_KEY;
            if (sgKey) {
              sgMail.setApiKey(sgKey);
              await sgMail.send({
                to: 'matt@moderntax.io',
                from: { email: 'notifications@moderntax.io', name: 'ModernTax Self-Serve' },
                replyTo: customerEmail || 'hello@moderntax.io',
                subject: `🎉 Self-serve purchase — ${packName} ($${amountUsd.toFixed(2)})`,
                html: `
<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#1a1a1a;max-width:560px;margin:24px auto;padding:24px;line-height:1.55;">
<h2 style="margin:0 0 8px;">New self-serve purchase</h2>
<p style="color:#666;margin:0 0 24px;">A prospect bought from the public ERC sample page (no portal account yet). Onboard them within 24 hours.</p>
<table style="width:100%;border-collapse:collapse;font-size:14px;">
  <tr><td style="padding:6px 0;color:#666;width:140px;">Pack:</td><td style="padding:6px 0;"><strong>${packName}</strong> (${packQty}× pulls)</td></tr>
  <tr><td style="padding:6px 0;color:#666;">Amount:</td><td style="padding:6px 0;"><strong>$${amountUsd.toFixed(2)}</strong></td></tr>
  <tr><td style="padding:6px 0;color:#666;">Email:</td><td style="padding:6px 0;"><a href="mailto:${customerEmail || ''}" style="color:#00C48C;">${customerEmail || '(not collected)'}</a></td></tr>
  <tr><td style="padding:6px 0;color:#666;">Name:</td><td style="padding:6px 0;">${customerName || '—'}</td></tr>
  <tr><td style="padding:6px 0;color:#666;vertical-align:top;">Billing address:</td><td style="padding:6px 0;">${companyName || '—'}</td></tr>
  <tr><td style="padding:6px 0;color:#666;">Stripe session:</td><td style="padding:6px 0;font-family:monospace;font-size:12px;">${session.id}</td></tr>
  <tr><td style="padding:6px 0;color:#666;">Stripe customer:</td><td style="padding:6px 0;font-family:monospace;font-size:12px;">${typeof session.customer === 'string' ? session.customer : '(none)'}</td></tr>
</table>
<h3 style="margin:24px 0 8px;">Next steps</h3>
<ol style="padding-left:20px;line-height:1.7;">
  <li>Reply directly to this email — the customer is the reply-to address.</li>
  <li>Create their <code>clients</code> + <code>profiles</code> row in Supabase admin (manager role, link to their Stripe customer id above).</li>
  <li>Email them a magic-link sign-in + a CSV template for the entities they want pulled.</li>
  <li>Once 8821s are signed, the existing intake flow takes over.</li>
</ol>
<p style="color:#888;font-size:12px;margin-top:24px;">View this purchase in <a href="https://dashboard.stripe.com/payments/${typeof session.payment_intent === 'string' ? session.payment_intent : ''}" style="color:#0066cc;">Stripe Dashboard</a>.</p>
</body></html>`,
              });
              console.log(`[stripe-webhook] self_serve: alert email sent to matt@moderntax.io for ${customerEmail} (${packName}, $${amountUsd.toFixed(2)})`);
            } else {
              console.warn('[stripe-webhook] self_serve: SENDGRID_API_KEY missing — skipped alert email');
            }
          } catch (emailErr) {
            console.error('[stripe-webhook] self_serve: alert email failed:', emailErr);
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

        // ─── Self-serve activation (2026-07-21) ────────────────────────────
        // This is the link that was missing: activateTrial() existed but
        // NOTHING called it, so a captured card never started the trial and
        // never granted the free pull. When the card capture came from the
        // self-serve flow, start the trial now — it stamps
        // trial_card_captured_at/started/expires and sets
        // trial_entities_allowed >= 1, which the order gate reads to let them
        // place their first transcript at no cost. Idempotent, and best-effort
        // so a trial hiccup can never fail the card save above.
        if (session.metadata?.flow === 'trial_activation') {
          try {
            const { activateTrial } = await import('@/lib/trial-activate');
            const r = await activateTrial(admin, clientId, session.metadata?.moderntax_user_id || null);
            console.log(`[stripe-webhook] trial activation for client ${clientId}: ${r.already_active ? 'already active' : 'ACTIVATED — 1 free pull granted'}`);
          } catch (e: any) {
            console.error('[stripe-webhook] activateTrial failed (card still saved):', e?.message || e);
          }
        }
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
