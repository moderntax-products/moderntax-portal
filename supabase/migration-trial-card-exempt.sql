-- Card-free trials for sales-led accounts (2026-07-22)
--
-- Background: clients created on/after the 2026-06-06 standard-plan cutoff must
-- have a card on file to order. That rule exists for SELF-SERVE signups, where
-- the card is the anti-abuse control that replaced admin approval (PR #74) —
-- anyone with a work email can sign up, so the card is what makes a free first
-- pull safe to offer.
--
-- It misfires on sales-led accounts. Business Finance Capital was onboarded by
-- us on 2026-07-17 with a manager (Elena Perceleanu) who was told she could
-- order, but the gate returned 402 card_required on every attempt. A real
-- customer could not place a single order.
--
-- bypass_payment_paywall is the wrong instrument here: it allows UNLIMITED
-- free orders. What we want is a bounded evaluation — a couple of orders with
-- full features, then the normal billing conversation.
--
-- This flag says: "this client's trial_entities_allowed may be consumed WITHOUT
-- a card." It stays FALSE by default, so self-serve signups are unaffected and
-- #74's protection is intact. The allowance itself remains the cap.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS trial_card_exempt BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN clients.trial_card_exempt IS
  'Admin-granted: this client may consume trial_entities_allowed with no card on file. Sales-led accounts only; FALSE for self-serve signups so the card remains the anti-abuse control.';

-- Index only the exempt rows — the column is overwhelmingly FALSE.
CREATE INDEX IF NOT EXISTS idx_clients_trial_card_exempt
  ON clients (id) WHERE trial_card_exempt = TRUE;
