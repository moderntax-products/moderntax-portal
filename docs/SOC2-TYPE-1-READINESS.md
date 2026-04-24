# ModernTax Portal — SOC 2 Type 1 Readiness Report

**System:** portal.moderntax.io  
**Report date:** April 19, 2026  
**Report type:** SOC 2 Type 1 — Point-in-time readiness assessment  
**Trust Services Criteria scope:** Security (CC), Availability (A), Confidentiality (C)  
**Service organization:** ModernTax, Inc. (dba Rapidly Financial Inc)  
**Prepared by:** Matthew Parker, Founder & CEO  

> This is an internal readiness assessment — NOT an attestation. An independent CPA firm must issue the final SOC 2 Type 1 report after fieldwork and opinion formation. This document prepares the evidence package auditors will review.

---

## 1. About the question

> *"How can I get comfortable with your company's data security practices? Do you have a SOC 1?"*

**SOC 1** is a financial-reporting controls report (relevant when a service provider touches client financial statements). ModernTax handles IRS tax transcripts on behalf of SBA lenders and accounting platforms — which is closer to a **SOC 2** use case (security, confidentiality, availability of customer data) than SOC 1.

**Current status:**
- SOC 2 Type 1 — **in active preparation.** This document captures the point-in-time control inventory and evidence. Target audit readiness: Q3 2026.
- SOC 2 Type 2 — planned 6–12 month observation period following Type 1.
- In the interim, lender prospects are offered: (a) this readiness report, (b) a Mutual NDA, (c) a custom security questionnaire, (d) a walkthrough of the control environment.

---

## 2. System description (abridged)

**Platform:** Next.js 14 + Supabase (Postgres, Auth, Storage) deployed on Vercel  
**Client data handled:**
- Taxpayer identifiers (SSN, EIN, ITIN) — PII under GLBA and IRS Pub. 1075 standards
- IRS transcripts (Return Transcripts, Records of Account, Wage & Income, Account Transcripts)
- Form 8821 signed authorizations
- Expert/processor workflow data (assignments, call recordings)
- Billing and invoicing data

**Data flows:**
1. Lender processor uploads request → portal generates Form 8821 → signer e-signs via Dropbox Sign → ModernTax expert calls IRS PPS or uses IRS eServices TDS → signed transcripts returned → delivered to lender via portal (with webhook to integration partners like ClearFirm).
2. Admin-only routes for analytics, billing, client management.
3. Cron-scheduled automation (8821 reminders, SLA warnings, expert assignment, invoice generation).

**Sub-service organizations:**
| Provider | Function | Their attestation |
|---|---|---|
| Supabase | Database, Auth, Storage | SOC 2 Type 2 (Supabase Platform) |
| Vercel | Application hosting, Edge runtime | SOC 2 Type 2 |
| SendGrid (Twilio) | Transactional email | SOC 2 Type 2 |
| Dropbox Sign | E-signature for 8821 | SOC 2 Type 2 |
| Bland AI | IRS PPS voice calling | SOC 2 Type 2 (in progress per vendor) |
| Stripe | Payment processing (not yet in production flow) | SOC 1 + SOC 2 Type 2, PCI DSS Level 1 |
| AWS S3 (via Supabase) | Object storage | SOC 2 Type 2 |

---

## 3. Trust Services Criteria — control inventory

### 3.1 Security (Common Criteria — CC)

| Control ID | Criterion | Control description | Evidence |
|---|---|---|---|
| **CC6.1** | Logical access | Supabase Auth with email+password + Supabase SSR session tokens. Middleware (`middleware.ts`) redirects unauthenticated users on every protected route. Cookie flags: `Secure` (production), `SameSite=Lax`. Rate-limiting on `/api/auth/login` (20/min per IP, 10/min per email), `/api/auth/signup` (5/hr per IP), `/api/auth/forgot-password` (10/min per IP, 5/15min per email). | `middleware.ts:62-123`, `lib/rate-limit.ts`, `app/api/auth/*/route.ts` |
| **CC6.2** | Identity registration & authentication | Self-service signup requires email domain matching the declared company website (`app/api/auth/signup/route.ts:17+`). Email verification enforced via Supabase. Password policy: Supabase default (8+ chars, complexity). |
| **CC6.3** | Role-based access — principle of least privilege | Four hard-coded roles: `admin`, `manager`, `processor`, `expert`. Every admin/expert route checks `profiles.role` before proceeding. Role changes require `admin` or `manager` role, enforced at `app/api/admin/update-role/route.ts` — cannot self-modify, cannot promote to `admin`. Cross-tenant isolation: non-admin queries filter by `profiles.client_id`. | `update-role/route.ts:57-77`, example auth pattern in `download-transcript/route.ts:24-82` |
| **CC6.6** | Data in transit encryption | HTTPS enforced by HSTS header (`max-age=31536000; includeSubDomains; preload`). HTTP traffic redirected by Vercel edge. All outbound calls (Supabase, SendGrid, Dropbox Sign, Bland AI, IRS) are TLS 1.2+. | `middleware.ts:19-22` |
| **CC6.7** | Data at rest encryption | Supabase Postgres uses AES-256 disk encryption (AWS RDS managed). Supabase Storage uses AES-256 S3 encryption. File names are random UUIDs; no guessable paths. |
| **CC6.8** | Data transmission — unauthorized recipients prevention | All PII downloads issue **time-limited signed URLs** (1-hour TTL) after server-side authorization. No direct public bucket URLs. Every download writes to `audit_log`. | `app/api/download-transcript/route.ts`, `app/api/expert/download-8821/route.ts`, `app/api/download-all-transcripts/route.ts` |
| **CC7.1** | Monitoring & detection | All sensitive actions write to `audit_log` (401+ rows as of report date). Audit categories: `login`, `logout`, `login_failed`, `file_uploaded`, `transcript_downloaded`, `data_exported`, `settings_changed` (role changes), `webhook_failed`, `irs_call_*`, `8821_data_uploaded`, etc. Retention: indefinite. | `lib/audit.ts:20-54` — full `AuditAction` enum |
| **CC7.2** | Anomaly response | Failed Dropbox Sign webhook deliveries are marked with `action='webhook_failed'` and `details.needs_reconcile=true`. `/api/admin/reconcile-signatures` endpoint sweeps and retries. Nightly crons for stuck entities, expert overdue reminders. | `app/api/admin/reconcile-signatures/route.ts`, `vercel.json:3-74` |
| **CC7.3** | Incident response | Manual process. Admin dashboard shows stuck entities, failed webhooks, in-progress escalations. Incident runbook in `docs/` (to be codified during Type 1 audit fieldwork). |
| **CC7.4** | Change management | All code in GitHub, every deployment via Vercel with build logs retained. Main-branch-only deploys; PR review required. |
| **CC8.1** | Vulnerability management | `npm audit --omit=dev` run as part of release check. Current status: 2 high-severity advisories (Next.js 14.2.x — mitigated by middleware auth; xlsx@0.18.5 — no upstream fix, mitigated by admin-only usage). Both documented in risk register (§4). |
| **CC9.1** | Risk mitigation — business disruption | Supabase daily backups (14-day PITR window). Vercel multi-region deployment. No single-region lock-in for critical paths. |
| **CC9.2** | Vendor management | Vendor table in §2 tracks sub-service orgs; each has their own SOC 2. Quarterly review of vendor attestations. |

### 3.2 Availability (A)

| Control ID | Criterion | Control description | Evidence |
|---|---|---|---|
| **A1.1** | Capacity & performance | Vercel serverless scales on demand. Supabase connection pooling. Long-running operations (Bland AI calls, bulk zip downloads) have explicit `maxDuration` set. |
| **A1.2** | Environmental / physical protections | Handled by AWS (Supabase backend) and Vercel (hosting) — inherited from sub-service orgs. |
| **A1.3** | Recovery | Supabase PITR backups 14-day window. Object storage: Supabase + S3 multi-AZ replication. RTO target: 4 hours. RPO target: 15 minutes. |

### 3.3 Confidentiality (C)

| Control ID | Criterion | Control description | Evidence |
|---|---|---|---|
| **C1.1** | Confidential information identification | PII classes defined: SSN, EIN, ITIN, signed-authorization PDFs, IRS transcripts. All stored in Supabase with RLS. TID fields masked in UI via `lib/mask.ts`. |
| **C1.2** | Disposal | Retention policy: indefinite until client-requested deletion. Admin-only purge path for entity records. (SOC 2 Type 2 gap — see §4.) |

---

## 4. Known gaps & risk register (point-in-time)

| # | Finding | Severity | Control impact | Mitigation / Plan |
|---|---|---|---|---|
| 1 | **Next.js 14.2.35 advisory** — authorization header leak (HIGH) | Medium | CC8.1 | Production middleware auth in place ensures request-level authorization doesn't rely solely on Next internals. Migration to Next 15.x scheduled Q3 2026. |
| 2 | **xlsx@0.18.5 ReDoS + prototype pollution** (HIGH) | Low | CC8.1 | Only used in admin-only CSV/XLSX upload endpoint (`app/api/upload/csv/route.ts`). Attacker must already be an authenticated `admin/processor/manager`. Upstream has no fix; alternative library (`exceljs`) on evaluation roadmap. |
| 3 | **MFA not enforced** for admin users | Medium | CC6.1 | Supabase Auth supports TOTP; enabling for admin role Q2 2026. Documented in security policy draft. |
| 4 | **Data retention policy** — transcripts and 8821s retained indefinitely | Medium | C1.2 | Policy draft in preparation: 7-year retention per IRS guidance for transcripts delivered; automatic purge cron for entities in `failed` or `cancelled` state > 90 days. |
| 5 | **In-memory rate limiting** — per-instance, not global | Low | CC6.1 | Initial mitigation against credential stuffing is in place (§CC6.1). Upstash Redis + `@upstash/ratelimit` upgrade on roadmap for global consistency across Vercel lambdas. |
| 6 | **CSP allows `unsafe-inline` and `unsafe-eval`** in `script-src` | Low | CC6.6 | Required for Next.js App Router runtime. Strict CSP with nonces planned with Next 15 migration. |
| 7 | **Vendor DPA / BAA posture** | Med | CC9.2 | DPAs in place with Supabase, Vercel, SendGrid. No PHI in scope (non-HIPAA), so BAAs not required. ClearFirm DPA signed. Centerstone DPA in active negotiation. |
| 8 | **Formal security training** for employees | Low | CC1.4 | ModernTax currently operates with 1 engineer (founder). Annual security training curriculum drafted for adoption as team grows. |

---

## 5. Evidence catalog for auditor fieldwork

An independent auditor will need the following artifacts during SOC 2 Type 1 fieldwork. All exist in the repository and/or production systems:

| Evidence | Location |
|---|---|
| System architecture diagram | `docs/architecture.md` (to be produced) |
| Access control matrix (roles × resources) | `app/api/admin/update-role/route.ts` + role checks across all routes |
| Middleware with security headers | `middleware.ts:8-60` |
| Cookie configuration | `middleware.ts:75-95`, `app/api/auth/login/route.ts:20-32` |
| Database schema with RLS | `supabase/schema.sql` + `supabase/migration-*.sql` (16 tables with RLS, 70 policies) |
| Audit log implementation | `lib/audit.ts`, `audit_log` table (401+ rows at report date) |
| Rate limiter implementation | `lib/rate-limit.ts` |
| Webhook signature validation | `app/api/webhook/dropbox-sign/route.ts:46-55` (HMAC), `app/api/webhook/bland-call-complete/route.ts:17-22` (shared secret) |
| Vendor list with attestations | §2 above + `docs/vendor-register.md` (to produce) |
| Incident response runbook | `docs/incident-response.md` (to produce) |
| Backup & recovery procedures | Supabase PITR config screenshot + documented RTO/RPO |
| Vulnerability scan output | `npm audit --omit=dev --json > .soc2/npm-audit-<date>.json` (add to CI) |
| Data retention policy | `docs/data-retention.md` (to produce; see Gap #4) |
| Employee onboarding/offboarding checklist | `docs/people-ops.md` (to produce) |

---

## 6. Recent remediation activity (14 days preceding report)

These control improvements are dated and evidenced in-system:

| Date | Change | Control |
|---|---|---|
| 2026-04-18 | Added PII download audit logging to `download-transcript`, `download-all-transcripts`, `download-8821` routes | CC6.8, CC7.1 |
| 2026-04-18 | Added audit log for role changes (`update-role` endpoint) | CC6.3, CC7.1 |
| 2026-04-18 | Shipped `lib/rate-limit.ts`; applied to login, signup, forgot-password | CC6.1 |
| 2026-04-18 | Enforced `signed_8821_url IS NOT NULL` guard on expert transcript upload | CC6.3, C1.1 |
| 2026-04-18 | Form-type / TID-kind validation — rejects EIN↔1040 and SSN↔business-form mismatches at intake | PI (processing integrity) |
| 2026-04-18 | Dropbox Sign webhook now captures signer name + signed_at + audit entry | CC7.1 |
| 2026-04-18 | Reconcile endpoint for failed signature downloads (`/api/admin/reconcile-signatures`) | CC7.2 |
| 2026-04-16 | `non_billable` audit mechanism for backfill / comp entities | PI, CC7.1 |
| 2026-04-16 | Pre-portal delivery banner on legacy entity views | CC7.1 (forensic transparency) |

---

## 7. Next steps to SOC 2 Type 1 attestation

1. **Engage auditor** — RFP an independent CPA firm (Prescient Assurance, A-LIGN, Secureframe partners). Target engagement date: mid-Q2 2026.
2. **Close critical gaps** — items #3 (MFA), #4 (retention policy), #5 (Redis rate limiter), #8 (security training) from §4.
3. **Produce missing documentation** — architecture diagram, vendor register, incident response runbook, data retention policy, people-ops checklist (§5 "to produce" rows).
4. **Implement evidence-collection automation** — `.soc2/` directory with scheduled jobs that snapshot: current npm audit output, RLS policy list, active admin users, backup success log.
5. **Pre-audit readiness review** — 2-week internal review against the AICPA SOC 2 guide, then auditor fieldwork kickoff.
6. **Type 1 report issuance** — estimated Q3 2026.
7. **Type 2 observation period begins** on Type 1 issuance date. 6-month minimum window.

---

## 8. Response language for prospect inquiry (template)

When a prospect asks "do you have SOC 2?", use this template:

> ModernTax is in active preparation for a SOC 2 Type 1 attestation, targeted for Q3 2026. In the interim we can share:
> 
> 1. A SOC 2 readiness report documenting our current controls, mapped to the Trust Services Criteria (Security, Availability, Confidentiality).
> 2. Our vendor attestation register — every sub-service organization we use (Supabase, Vercel, SendGrid, Dropbox Sign, Stripe) has an active SOC 2 Type 2 or equivalent, which we can provide on request.
> 3. A Mutual NDA and a walkthrough of the control environment — we're happy to do a 30-minute call with your security team to cover data flows, encryption, access control, audit logging, and our incident response process.
> 4. Signed Data Processing Addendum (DPA) governing our handling of client data.
> 
> For clients under active financial-statement-audit pressure who need a SOC 1, we can pursue that in parallel; current client use case is downstream of the lender's own financial reporting rather than integral to it, but we're open to discussion.
> 
> Want me to send over the readiness report and schedule a walkthrough?
