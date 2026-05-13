# Mento Technologies / TaxTaker — Next Actions

**Entity:** Mento Technologies, Inc.
**EIN:** 84-3203499
**Client:** TaxTaker, Inc.
**Entity ID:** `f92264b1-d420-4865-93f0-33943fc507ff`
**Admin URL:** https://portal.moderntax.io/admin/erc-report/f92264b1-d420-4865-93f0-33943fc507ff
**8821:** signed, on file, CAF 0316-30210R active (TC 960 confirmed 1/31/2025)

## What we have

| Quarter | Period Ending | Pulled? | Status | Refund |
|---|---|---|---|---|
| Q4 2020 | 12/31/2020 | ✓ | $0 balance, no ERC activity | — |
| Q3 2021 | 9/30/2021 | ✓ | **STUCK — refund returned undelivered** | $35,449.33 issued 8/29/22, TC 740 same day |
| Q4 2021 | 12/31/2021 | ✗ **MISSING** | Unknown — needs pull | RSB-eligible per Ari |
| Q2 2022 | 6/30/2022 | ✓ | $0 balance, refund issued/cleared $11,228.86 | (not ERC) |

## Upsells live in this thread

1. **Q4 2021 transcript pull** — $79.98. No new 8821, expert just needs to re-call IRS PPS with the existing creds + request period ending 12/31/2021. SLA: tomorrow morning.
2. **Q3 2021 check reissue** — $999.99 (Stripe) or $1,000 (Mercury ACH). Form 8822-B + B&S call.
3. **Portfolio scan MSA** — ERC Full Sweep $159.96/entity across TaxTaker's book, $1K per recovered check.

## To trigger Q4 2021 pull

Easiest path: create a new request for Mento Technologies under the TaxTaker client with form_type=941, period=2021-Q4 only. Reuse the entity_id so the existing 8821 carries over.

## To trigger the check reissue

Use the in-portal flow once Ari confirms:
- Visit https://portal.moderntax.io/admin/erc-report/f92264b1-d420-4865-93f0-33943fc507ff
- Q3 2021 row will show "Request Check Reissue · $1,000 (Mercury ACH)" — clicking creates the `check_reissue_requests` row and emails matt@moderntax.io with the Mercury invoice details
- OR send Ari the public Stripe link if he wants to pay $999.99 by card today
