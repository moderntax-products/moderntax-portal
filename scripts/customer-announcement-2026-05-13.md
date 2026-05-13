# Customer-facing announcement — Compliance Status Report + Income Monitoring

Two related emails. The first is what `scripts/backfill-compliance-reports.mjs`
sends automatically (one per recipient, customized with their portfolio
rollup). The second is a Matt-from-CEO note to send manually to high-touch
trial customers (Banc of California, Enterprise Bank, TaxTaker) that frames
the upgrade in the context of their specific competitor (Tax Guard) and
their specific feedback.

---

## Email 1 — sent by `scripts/backfill-compliance-reports.mjs`

Already templated inside the backfill script. Each recipient (manager,
processor, team_member at every client with completed entities) gets one
email with a portfolio rollup table linking to per-entity reports. Subject
shifts based on findings count:

  - With findings: "New Compliance Status Reports — N of M entities flagged"
  - All clean: "New Compliance Status Reports — N entities (all clean)"

Recommend running dry-run first:

  npx tsx scripts/backfill-compliance-reports.mjs --dry-run

then live:

  npx tsx scripts/backfill-compliance-reports.mjs

---

## Email 2 — Matt manual send to Banc of California, Enterprise Bank, TaxTaker

Subject: **What's new at ModernTax — compliance synthesis + post-funding income monitoring**

Hi {first_name},

Two product upgrades shipped this week, both driven directly by feedback
from your team and a couple of others on similar SBA workflows. Wanted to
make sure you saw what changed:

**1. Compliance Status Report — now on every transcript pull, no extra cost**

Every completed entity in your portfolio now has a structured Compliance
Status Report alongside the raw transcripts. Three sections matching what
your underwriters actually need to see at decision time:

  • **Filing Compliance** — required-vs-filed by form/period (e.g. "1120-S 2023 filed 3/15/2024", "941 2024 Q1 unfiled — overdue"). Sourced from Account Transcript TC 150 entries cross-referenced against blank no-record results.
  • **Tax Liabilities by Period** — itemized: assessed / paid / balance / accruing interest+penalty, with totals. Each row traces to a specific transcript.
  • **Repayment Plan Status** — Installment Agreement / Offer in Compromise / Currently-Not-Collectible (TC 480 / 481 / 482 / 520 / 530 / 971 codes), with the recommended next step ("Online Payment Agreement, ~24h approval for sub-$50K balances" etc.)

Sample format: https://portal.moderntax.io/sample-transcripts/compliance-report

Per-entity report: https://portal.moderntax.io/admin/compliance-status/{entityId}
(link goes straight to your entity once you sign in)

**2. Post-funding income monitoring**

For accounts on monitoring (or any account you want to enroll), we now
baseline the borrower's income figures at loan-approval time and reconcile
against each subsequent transcript pull. When the IRS posts a new tax
return, we extract gross receipts / total income / total tax / AGI from
the fresh transcript and compare against the baseline. Material variance
(>15%) triggers an email alert; smaller variance shows up as a note in
the compliance dashboard.

Use cases this enables:
  • Confirming actual filed income matches the loan-approval pro forma
  • Catching unreported income before the IRS reconciliation does
  • Audit defense — every pull (including no-record-found) stays in the
    audit log for the life of the loan

Enroll any existing entity in monitoring from the request detail page;
new entities can be auto-enrolled at intake.

**3. Behind the scenes**

  • 24-hour SLA holding steady (96%+ on-time completion)
  • New phone-pool rotation across NY / Chicago / Denver / SF Bay area-codes for IRS PPS calls — keeps us out of the "single number flagged" failure mode
  • IRS PPS AI agent caught and patched an autonomy bug that was wasting hold time on calls without callback offers

Reply with feedback — especially if there's a Tax Guard report element you
still want to see in our compliance synthesis. The point is parity, then
better.

Best,
Matt Parker
matt@moderntax.io · 650-741-1085 · ModernTax, Inc.

---

## Notes for Matt

Customization per recipient:

- **Erin Wilsey (Banc of California)** — emphasize "the structured compliance synthesis you flagged on 5/12 (unfiled forms / tax liabilities / repayment plan) is now bundled with every pull." Her first live pull (request #21402, White's Collision Service) has a CRITICAL severity flag due to 1 unfiled return — she'll see it the moment she opens the report.

- **Derek Le / Roberto Venturella (Enterprise Bank)** — emphasize "post-funding income monitoring matches what you mentioned your current vendor (Tax Guard) offers for tax-return reconciliation. Now built in. Ready when you send those three trial EINs."

- **Ari Salafia (TaxTaker)** — emphasize "the income-baseline + reconciliation flow also works for the PEO clients we discussed — once we get a single transcript per quarter from Trinet, we can baseline against the loan-approval figures and surface any deltas."
