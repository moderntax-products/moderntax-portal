# MASTER SERVICES AGREEMENT (Amended)

**This Master Services Agreement (the "Agreement") is entered into as of [EFFECTIVE_DATE] (the "Effective Date"), by and between ModernTax, Inc., a Delaware C-corporation with its principal place of business at 2 Embarcadero Center, 8th Floor, San Francisco, CA 94111 ("ModernTax"), and [CUSTOMER_NAME], with its principal place of business at [CUSTOMER_ADDRESS] ("Client"). ModernTax and Client are each a "Party" and collectively the "Parties."**

This Agreement amends, restates, and supersedes any prior order form, statement of work, or master agreement between the Parties relating to the Services. Verifications, monitoring activity, and other Services delivered prior to the Effective Date remain governed by the prior agreement; Services delivered on or after the Effective Date are governed by this Agreement.

---

## 1. Services

**1.1 Services.** ModernTax will provide Client with access to its IRS tax transcript verification platform (the "Services"), including: (a) digital IRS Form 8821 signature workflow; (b) pull of IRS account transcripts, return transcripts, record of account, business entity transcripts, and related records; (c) optional continuous account monitoring; and (d) web-based and API access to completed verification reports.

**1.2 Platform Access.** ModernTax will provision user accounts at portal.moderntax.io for Client's authorized personnel. Client is responsible for maintaining the confidentiality of account credentials and for all activity conducted through its accounts.

**1.3 Taxpayer Authorization.** Client shall obtain a duly executed IRS Form 8821 (or equivalent authorization) from each taxpayer whose information is the subject of a Service request, authorizing ModernTax (CAF 0316-30210R) as designee. Where Client has elected ModernTax-Prepared 8821 generation under Section 2.1, ModernTax will prepare and route the 8821 for taxpayer signature on Client's behalf.

**1.4 Service Levels.** ModernTax targets delivery within 24–48 hours of request submission on IRS business days, subject to IRS system availability and the volume of authorizations in queue. Monitoring updates will be delivered as changes are detected on enrolled accounts.

---

## 2. Fees and Payment

**2.1 Service Tier Selection.** Client has selected the tier indicated below (one of three). The fee schedule for the selected tier governs all Services delivered during the term.

| Selected | Tier | Verification Rate | Onboarding | Monthly Platform Fee | Other-Fee Discount |
|:---:|---|---|---|---|---|
| **[ ☐ ]** | **A. Pay-As-You-Go (PAYG)** | $79.98 / TIN | None | None | None |
| **[ ☐ ]** | **B. Deposit / Onboarding** | $59.98 / TIN | $2,500 deposit (applied as credits) | None | None |
| **[ ☐ ]** | **C. Platform / API Access** | $39.99 / TIN | None | $2,500 / month | 20% off other fees |

**Selected tier:** ☐ A — PAYG  ☐ B — Deposit/Onboarding  ☐ C — Platform/API Access *(check one)*

---

**2.1.A Tier A — Pay-As-You-Go (PAYG)**

| Service | Unit | Price |
|---|---|---|
| IRS Transcript Verification (TRT + ROA, 4 yrs of historical data) | per TIN | **$79.98** |
| Re-Orders (repeat pulls on the same TIN) | per pull | **$79.98** *(same as base rate)* |
| Entity Transcript Add-On (when Client opts to pull entity transcript) | per pull | **$19.99** |
| ModernTax-Prepared 8821 Generation & E-Signature | per entity | **$10.00** |
| Account Monitoring | per TIN per month | **$25.00** *(billed monthly until Client cancels enrollment)* |

No deposit. No monthly platform fee. Full month-to-month flexibility.

---

**2.1.B Tier B — Deposit / Onboarding**

| Service | Unit | Price |
|---|---|---|
| IRS Transcript Verification (TRT + ROA, 4 yrs of historical data) | per TIN | **$59.98** *(25% discount vs PAYG)* |
| Re-Orders (repeat pulls on the same TIN) | per pull | **$59.98** *(same as base rate)* |
| Entity Transcript Add-On | per pull | **$19.99** |
| ModernTax-Prepared 8821 Generation & E-Signature | per entity | **$10.00** |
| Account Monitoring | per TIN per month | **$25.00** *(billed monthly until Client cancels enrollment)* |

**Onboarding deposit of $2,500.00** is paid prior to or on the Effective Date and applied as credit against usage as it accrues. No further deposit is required after the initial credit is exhausted.

---

**2.1.C Tier C — Platform / API Access**

| Service | Unit | Price |
|---|---|---|
| IRS Transcript Verification (TRT + ROA, 4 yrs of historical data) | per TIN | **$39.99** *(50% discount vs PAYG)* |
| Re-Orders (repeat pulls on the same TIN) | per pull | **$39.99** *(same as base rate)* |
| Entity Transcript Add-On | per pull | **$15.99** *(20% off list)* |
| ModernTax-Prepared 8821 Generation & E-Signature | per entity | **$8.00** *(20% off list)* |
| Account Monitoring | per TIN per month | **$20.00** *(20% off list)* |
| **Platform / API Access (monthly subscription)** | per month | **$2,500.00** |

**Tier C Platform Fee includes:**

- 24/7 Customer Success access (dedicated Slack channel + named CSM)
- Real-time transcript delivery feed (webhooks, API push)
- Compliance reporting suite (CRITICAL/WARNING flag rollups, exposure dashboards)
- Loan-package PDF templates and white-label cover sheets
- Direct REST API access (`/api/v1/verify`, `/api/v1/monitor`, `/api/v1/transcripts`)
- API key management with role-based access
- Priority queue placement (Tier C requests are pulled ahead of Tier A/B within the standard 24–48 hour SLA)
- Priority IRS PPS escalation when transcripts are blocked

The Platform Fee is billed monthly on the first of each month for the upcoming calendar month and is non-refundable for partial months. Per-TIN verification, monitoring, and add-on charges are billed monthly in arrears alongside the next Platform Fee.

---

**2.2 Pay-As-You-Go; No Minimums (Tiers A and B).** For Tiers A and B, this Agreement is billed on a usage basis. There is no monthly minimum commitment. Client is invoiced only for Services actually used during each billing period. Tier C carries the monthly Platform Fee as the only minimum commitment.

**2.3 Onboarding Deposit (Tier B only).** [DEPOSIT_CLAUSE_OR_REMOVE — see "deposit clauses" below]

**2.4 Billing Cycle.** ModernTax will invoice Client on or about the first (1st) calendar day of each month for Services delivered during the preceding calendar month. Each invoice is accompanied by an itemized breakdown showing every entity, the requesting team member, and the rate applied. Invoices are due **net [NET_DAYS] days** from the invoice date.

**2.5 Payment Method.** Invoices will be delivered electronically through ModernTax's billing partner (Mercury) to a billing contact designated by Client. Payment may be made by ACH transfer or check. Client may enroll in Mercury auto-pay from any invoice's pay page; auto-pay applies to all subsequent invoices until cancelled.

**2.6 Unsuccessful Pulls.** No charge applies to verification requests that fail due to IRS system error, invalid 8821, or absence of an account on file.

**2.7 Late Payments.** Amounts not paid when due accrue interest at the lesser of 1.5% per month or the maximum rate permitted by law, from the due date until paid.

**2.8 Taxes.** Fees are exclusive of all taxes. Client is responsible for all sales, use, and similar taxes arising from the Services, excluding taxes on ModernTax's net income.

**2.9 Price Changes.** ModernTax may adjust Services pricing upon thirty (30) days' prior written notice. Adjusted pricing applies only to Services delivered after the effective date of the change.

---

## 3. Term and Termination

**3.1 Term.** This Agreement commences on the Effective Date and continues month-to-month until terminated as set forth below.

**3.2 Termination for Convenience.** Either Party may terminate this Agreement at any time upon thirty (30) days' prior written notice to the other Party. Services accrued through the effective date of termination remain payable.

**3.3 Termination for Cause.** Either Party may terminate this Agreement immediately upon written notice if the other Party materially breaches this Agreement and fails to cure such breach within fifteen (15) days of receiving written notice.

**3.4 Effect of Termination.** Upon termination, Client's access to the ModernTax platform will be deactivated. Client may request export of its verification reports within thirty (30) days of termination. Sections 4 (Confidentiality), 5 (Data Protection), 7 (Limitation of Liability), 8 (Indemnification), and 9 (General) survive termination.

---

## 4. Confidentiality

**4.1 Definition.** "Confidential Information" means any non-public business, technical, or financial information disclosed by one Party to the other in connection with this Agreement, whether or not marked as confidential, that a reasonable person would understand to be confidential.

**4.2 Obligations.** Each Party shall: (a) use the other's Confidential Information solely to perform under this Agreement; (b) protect it with the same degree of care it uses for its own confidential information (and in no event less than a reasonable standard of care); and (c) not disclose it to any third party except to employees, advisors, or contractors bound by confidentiality obligations at least as protective as those herein.

**4.3 Exclusions.** Confidential Information does not include information that is: (a) publicly known through no fault of the receiving Party; (b) already known to the receiving Party without restriction; (c) independently developed without reference to the other Party's information; or (d) required to be disclosed by law or court order, provided prompt written notice is given to the disclosing Party where permitted.

---

## 5. Data Protection and Security

**5.1 Taxpayer Data.** ModernTax handles taxpayer information obtained in the course of providing the Services in accordance with IRS regulations, the Gramm-Leach-Bliley Act, applicable state data protection laws, and ModernTax's published Security Practices. ModernTax maintains a SOC 2 Type II attestation.

**5.2 Use Limitations.** ModernTax will process taxpayer data solely to provide the Services to Client and for ModernTax's internal operations related to the Services. ModernTax will not sell taxpayer data or use it for advertising.

**5.3 Security Measures.** ModernTax implements administrative, physical, and technical safeguards designed to protect taxpayer data against unauthorized access, disclosure, or destruction, including encryption in transit and at rest, role-based access controls, and logging and monitoring.

**5.4 Incident Notification.** ModernTax will notify Client without undue delay, and in any event within seventy-two (72) hours, after becoming aware of any unauthorized access to or disclosure of Client's Confidential Information or taxpayer data.

---

## 6. Representations and Warranties

**6.1 Mutual.** Each Party represents and warrants that: (a) it has full corporate power and authority to enter into and perform this Agreement; and (b) its execution and performance will not violate any other agreement to which it is bound.

**6.2 Client.** Client represents and warrants that it has obtained, or will obtain prior to each Service request, all authorizations required under applicable law from each taxpayer whose information is the subject of a request, including a valid IRS Form 8821 naming ModernTax as designee.

**6.3 Services Warranty.** ModernTax will perform the Services in a professional and workmanlike manner consistent with generally accepted industry standards. As Client's sole and exclusive remedy for breach of the foregoing warranty, ModernTax will re-perform the non-conforming Services at no additional charge.

**6.4 Disclaimer.** EXCEPT AS EXPRESSLY SET FORTH HEREIN, THE SERVICES ARE PROVIDED "AS IS." MODERNTAX DISCLAIMS ALL OTHER WARRANTIES, EXPRESS OR IMPLIED, INCLUDING WITHOUT LIMITATION WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. MODERNTAX DOES NOT WARRANT THAT THE SERVICES WILL BE UNINTERRUPTED, ERROR-FREE, OR THAT THE IRS WILL PROCESS EVERY REQUEST; IRS SYSTEMS AND ACCEPTANCE ARE OUTSIDE MODERNTAX'S CONTROL.

---

## 7. Limitation of Liability

**7.1 Cap.** EXCEPT FOR LIABILITY ARISING FROM A PARTY'S BREACH OF SECTION 4 (CONFIDENTIALITY), INDEMNIFICATION OBLIGATIONS UNDER SECTION 8, OR GROSS NEGLIGENCE OR WILLFUL MISCONDUCT, EACH PARTY'S TOTAL CUMULATIVE LIABILITY UNDER THIS AGREEMENT WILL NOT EXCEED THE FEES PAID BY CLIENT TO MODERNTAX DURING THE TWELVE (12) MONTHS PRECEDING THE EVENT GIVING RISE TO THE CLAIM.

**7.2 Exclusions.** IN NO EVENT WILL EITHER PARTY BE LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR FOR LOST PROFITS OR LOST REVENUE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.

---

## 8. Indemnification

**8.1 By ModernTax.** ModernTax will defend and indemnify Client against any third-party claim alleging that the Services, as provided by ModernTax and used in accordance with this Agreement, infringe any U.S. patent, copyright, or trademark, and will pay damages finally awarded or settlement amounts agreed to by ModernTax.

**8.2 By Client.** Client will defend and indemnify ModernTax against any third-party claim arising from: (a) Client's failure to obtain required taxpayer authorizations; or (b) Client's misuse of Services or data provided through the Services in violation of law or this Agreement.

**8.3 Procedure.** The indemnified Party shall: (a) promptly notify the indemnifying Party in writing; (b) grant the indemnifying Party sole control of the defense and any settlement; and (c) provide reasonable cooperation, at the indemnifying Party's expense.

---

## 9. General

**9.1 Independent Contractors.** The Parties are independent contractors. Nothing in this Agreement creates any agency, partnership, joint venture, or employment relationship.

**9.2 Assignment.** Neither Party may assign this Agreement without the other's prior written consent, except that either Party may assign this Agreement to a successor in connection with a merger, acquisition, or sale of substantially all of its assets.

**9.3 Governing Law.** This Agreement is governed by the laws of the State of Delaware, without regard to conflict-of-laws principles. The Parties consent to the exclusive jurisdiction of state and federal courts located in the State of Delaware for any dispute arising out of or relating to this Agreement.

**9.4 Notices.** All notices must be in writing and delivered by email with read confirmation or by overnight courier to the addresses set forth above (or to matt@moderntax.io for ModernTax and [CLIENT_NOTICE_EMAIL] for Client). Notices are effective upon receipt.

**9.5 Force Majeure.** Neither Party will be liable for any failure or delay in performance caused by events beyond its reasonable control, including acts of God, natural disasters, war, terrorism, labor disputes, governmental action, or failures of the internet or IRS systems.

**9.6 Severability; Waiver.** If any provision is held unenforceable, the remaining provisions remain in full force. No waiver of any breach is effective unless in writing, and no waiver constitutes a waiver of any subsequent breach.

**9.7 Entire Agreement; Amendment.** This Agreement constitutes the entire agreement between the Parties regarding the subject matter and supersedes all prior agreements. Amendments must be in writing and signed by both Parties.

**9.8 Counterparts; Electronic Signatures.** This Agreement may be executed in counterparts, including by electronic signature, each of which is deemed an original and together constitute one instrument.

---

**IN WITNESS WHEREOF, the Parties have executed this Agreement as of the Effective Date.**

| **ModernTax, Inc.** | **[CUSTOMER_NAME]** |
|---|---|
| Signature: ________________________ | Signature: ________________________ |
| Name: Matthew Parker | Name: [SIGNER_NAME] |
| Title: Founder & Chief Executive Officer | Title: [SIGNER_TITLE] |
| Date: __________ | Date: __________ |

---

## DEPOSIT CLAUSES (per-customer)

**For Centerstone SBA Lending (deposit already paid 9/15/2025):**

> **2.3 Onboarding Deposit (Tier B).** Client made a $1,000 onboarding deposit on September 15, 2025 under the prior Order Form, which has been applied as credit toward usage and is fully reconciled as of the Effective Date. In recognition of Client's existing relationship and continuous engagement since September 2025, Client is grandfathered into Tier B (Deposit/Onboarding) without requiring a top-up to the standard $2,500 deposit amount. Client's Verification rate is $59.98 per TIN per Section 2.1.B.

**For TMC Financing (deposit due May 5, 2026):**

> **2.3 Onboarding Deposit (Tier B).** Client shall pay an onboarding deposit of $2,500.00 (covered by ModernTax invoice INV-16, due May 5, 2026). The deposit is applied as credit against Client's first month(s) of usage at the Verification rate of $59.98 per TIN per Section 2.1.B. No further deposit is required after the initial credit is exhausted.

**For Cal Statewide CDC (no amendment per Matt 2026-05-01 — keep existing MSA dated 4/21/2026):**

> *(NOT APPLICABLE — Cal Statewide remains on the existing MSA at $79.98/TIN + $25/TIN/month monitoring per Sections 2.1 of that MSA. The amended template (with Tier A/B/C selection) applies only to Centerstone SBA and TMC Financing as of June 1, 2026, and to all new customer signings going forward.)*

---

## CUSTOMER FILL VARIABLES

### Centerstone SBA Lending — Tier B (Deposit/Onboarding)
- `CUSTOMER_NAME`: Centerstone SBA Lending, Inc.
- `CUSTOMER_ADDRESS`: 915 Wilshire Blvd., Suite 1700, Los Angeles, CA 90017
- `EFFECTIVE_DATE`: June 1, 2026
- **Selected Tier: B — Deposit / Onboarding** ($59.98/TIN)
- `NET_DAYS`: 30
- `SIGNER_NAME`: Mathew Paek
- `SIGNER_TITLE`: FVP & Credit Manager
- `CLIENT_NOTICE_EMAIL`: mathew.paek@teamcenterstone.com (with cc jasmine.kim@teamcenterstone.com)
- Deposit clause: Centerstone version above (grandfathered $1,000 prior deposit; no top-up required)

### TMC Financing — Tier B (Deposit/Onboarding)
- `CUSTOMER_NAME`: TMC Financing, LLC
- `CUSTOMER_ADDRESS`: 1611 Telegraph Ave, Suite 504, Oakland, CA 94612
- `EFFECTIVE_DATE`: June 1, 2026
- **Selected Tier: B — Deposit / Onboarding** ($59.98/TIN)
- `NET_DAYS`: 30
- `SIGNER_NAME`: Grace Quintin
- `SIGNER_TITLE`: AVP, Loan Processing Manager
- `CLIENT_NOTICE_EMAIL`: grace@tmcfinancing.com (with cc kisha@tmcfinancing.com)
- Deposit clause: TMC version above ($2,500 deposit per INV-16, due May 5, 2026)

### Cal Statewide CDC — Tier A (PAYG)
*(Per Matt 2026-05-01: NO new MSA. Existing MSA dated 4/21/2026 stays in force at $79.98/TIN + $25/TIN/month monitoring per its Section 2.1.)*

### Tier C (Platform/API) — for future signups only
*(No existing customer is on Tier C as of June 1, 2026. Use the template for Platform/API tier customers as they sign on. Note: Clearfirm's existing $2,499/month subscription is structurally similar but predates this template; honor existing Clearfirm SOW until natural renewal.)*
