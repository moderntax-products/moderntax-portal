# TaxTaker reply — 2026-05-12

Ari's three asks:
1. $1,000 check reissue is too steep upfront given their per-client fees on Mento.
2. Volume pricing clarification: is the 5-pack $379.99 total or 5×$379.99?
3. PEO clients (Trinet specifically) — any success?

## Reply (paste into Gmail)

---

Hi Ari,

Quick answers to all three, plus a letter template you can use on the PEO side.

**1. On the $1,000 — fair pushback, here's the alternative**

Agreed that $1,000 upfront for an 8-week IRS turnaround doesn't pencil for every client. For the partner relationship I'd rather move to a contingency structure that aligns with how your fees flow:

- **Option A (contingency):** zero upfront, 5% of the recovered check. On Mento Q3 2021 that's $1,772 if the $35K comes back, $0 if it doesn't. We carry all the risk.
- **Option B (split):** $250 upfront to start the 8822-B + IRS call, $750 on recovery confirmation. Cuts your at-risk cash by 75%.
- **Option C (status quo):** $999.99 via Stripe up front, fastest start.

For Mento specifically I'd suggest we hold the reissue work until we've pulled Q4 2021 — if that quarter also has a returned-undelivered pattern, the recovery math gets much better and either contingency option starts to look obvious. **Want me to queue the Mento Q4 2021 pull at $79.98 today, tomorrow-morning SLA, no new 8821?** That gives us the full picture before either of us commits to the reissue spend.

**2. On the 5-pack pricing — $379.99 *total* for 5 entity pulls**

Apologies if the language was unclear. Side-by-side:

| Tier | Price | Coverage | Per-entity |
|------|-------|----------|------------|
| Single | $79.98 | 1 entity, up to 3 ERC quarters | $79.98 |
| 3-pack | $239.94 | 3 entities total, up to 3 quarters each | $79.98 |
| **5-pack** | **$379.99** | **5 entities total, up to 3 quarters each** | **$76.00** (~5% off) |
| Full Sweep | $159.96 | 1 entity, ALL 6–7 ERC quarters | — |

For TaxTaker's typical case (RSB clients claiming Q3 + Q4 2021), the **Full Sweep tier at $159.96/entity** matches the workflow better than the 5-pack — Full Sweep pulls every eligible quarter for a single entity in one shot. If you want to commit volume up front (10+ clients with full coverage each), happy to put together a custom enterprise rate — easier to spec on the call tomorrow than over email.

**3. On PEO clients (Trinet) — honest answer**

PEO claims are a known limitation of the standard 8821 + 941 transcript flow. When Trinet files the master Form 941 under their own EIN with the client's wages on Schedule R, an 8821 signed by the client's EIN authorizes us to access… nothing on the ERC side, because there's no 941 filed under the client's EIN. We've seen the same pattern with Justworks, Insperity, Paychex BPS, and ADP TotalSource.

What actually works for PEO ERC, in order of practicality:

**a. Request a PEO ERC Allocation Report from Trinet directly** — they're required to track per-client allocation on Form 941 Schedule R and provide the data to client companies. This is the fastest path. Letter template you can adapt below.

**b. Trinet's portal** — most PEOs have a self-service "tax credits" or "ERC reporting" section. Worth a 5-minute check before sending the letter.

**c. Form 4506-T + dual 8821s** — file 4506-T for the client EIN and a separate 8821 against Trinet's EIN. In practice PEOs almost never sign third-party 8821s for individual client claims, so this is theoretical.

For the two remaining Trinet claims, my recommendation is start with the letter (template below). If Trinet's tax team responds with the Schedule R allocation + refund history, we can build the ERC analysis from there — same report format as the Mento one, just from Trinet-supplied data instead of pulled transcripts. Happy to take that on at a custom rate per client since the analysis is the same.

**Trinet info-request letter template:**

```
[Date]
TriNet HR Corporation
Attn: Tax Department / ERC Allocation
1100 San Leandro Blvd, Suite 400
San Leandro, CA 94577

RE: Employee Retention Credit (ERC) Allocation Report
    Client EIN: [CLIENT_EIN]
    Client Legal Name: [CLIENT_LEGAL_NAME]
    Service Period: 2020 Q2 – 2021 Q4
    Submitted by: [YOUR_FIRM] as authorized tax representative
    Authorization on file: Form 8821 signed [DATE]

Dear TriNet Tax Team,

[CLIENT_LEGAL_NAME] is preparing an Employee Retention Credit
recovery analysis covering tax periods 2020 Q2 through 2021 Q4.
As TriNet filed the consolidated Forms 941 under TriNet's
master EIN during this period with [CLIENT_LEGAL_NAME]'s wages
reported on Schedule R, we are requesting the following client-
level allocation data:

1. Schedule R allocation lines for [CLIENT_LEGAL_NAME] for each
   of the following periods:
     - 2020 Q2, Q3, Q4
     - 2021 Q1, Q2, Q3
     - 2021 Q4 (Recovery Startup Business if applicable)
   Specifically: qualified wages, qualified health plan expenses,
   and the ERC credit amount claimed on Form 941-X (if filed).

2. The status of any Form 941-X amended return filed on
   [CLIENT_LEGAL_NAME]'s behalf, including:
     - Filing date
     - Amended credit amount
     - IRS acknowledgment / refund issuance status

3. Confirmation of where any refund check or credit was directed
   (to TriNet's account vs. allocated back to client).

We have a signed Form 8821 from [CLIENT_LEGAL_NAME]'s authorized
officer authorizing release of this information. A copy is
attached.

Please direct the response to [YOUR_EMAIL] or fax to [YOUR_FAX].

Thank you for your assistance.

Sincerely,
[YOUR_NAME]
[YOUR_TITLE], [YOUR_FIRM]
[PHONE]
```

**Next steps — let me know which of these to kick off today:**
- [ ] Mento Q4 2021 transcript pull ($79.98, no new 8821) — recommended
- [ ] Mento Q3 2021 reissue: contingency (A), split (B), or upfront (C)?
- [ ] PEO letters drafted for the 2 Trinet clients (send me their EINs)
- [ ] Custom enterprise quote for TaxTaker volume (need rough # of clients)

See you tomorrow.

Best,
Matt
