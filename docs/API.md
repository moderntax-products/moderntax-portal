# ModernTax Partner API

Base URL: `https://portal.moderntax.io`

This is the partner-facing API surface. All endpoints below are
authenticated via an `x-api-key` header issued by ModernTax. Keys are
stored as SHA-256 hashes; presented values are constant-time verified
against the hash on every request. Contact `matt@moderntax.io` to
provision a key for your account.

The portal also exposes admin / expert / processor cookie-authenticated
endpoints; those are NOT covered here and are not stable for
integration.

---

## Auth

All requests require:

```
x-api-key: <your_api_key>
Content-Type: application/json   (or multipart/form-data where noted)
```

A missing or invalid key returns `401 Unauthorized`. The same code
path runs whether the key is malformed, missing, or simply wrong, so
errors don't leak information about whether a partial match exists.

Rate limits and request quotas are configured per-account. Hitting the
quota returns `429 Too Many Requests` with a `Retry-After` header.

---

## Endpoints

### `POST /api/intake/transcript` — create a transcript request

Submit one or more entities (businesses or individuals) for IRS
transcript retrieval. ModernTax handles 8821 signature collection
(unless you upload a pre-signed PDF via `/api/intake/8821-pdf` after
this call), IRS interaction, transcript delivery, and compliance
analysis.

**Request**

```json
{
  "request_token": "your-loan-12345",
  "loan_number":   "your-loan-12345",
  "entities": [
    {
      "entity_name": "ACME Holdings LLC",
      "tid":         "12-3456789",
      "tid_kind":    "EIN",
      "form_type":   "1120S",
      "years":       ["2022", "2023", "2024"],
      "address":     "123 Main St",
      "city":        "Austin",
      "state":       "TX",
      "zip_code":    "78701",
      "signer_first_name": "Jane",
      "signer_last_name":  "Smith",
      "signer_email":      "jane@acme.com"
    }
  ],
  "callback_url": "https://your-app.example.com/webhooks/moderntax"
}
```

| Field | Required | Notes |
|---|---|---|
| `request_token` | yes | Your unique identifier for this request. Must be unique per ModernTax account. |
| `loan_number` | no | Falls back to `request_token` if omitted. Used in invoice itemization. |
| `entities[].entity_name` | yes | Legal name on file with the IRS. |
| `entities[].tid` | yes | EIN (`XX-XXXXXXX`) or SSN (`XXX-XX-XXXX`). |
| `entities[].tid_kind` | yes | `"EIN"` or `"SSN"`. Determines form-type validation. |
| `entities[].form_type` | no | One of `"1120"`, `"1120S"`, `"1065"`, `"1040"`, etc. If omitted, inferred from `tid_kind`. |
| `entities[].years` | yes | Array of 4-digit years. Supported range: 1990–2028. |
| `entities[].signer_*` | conditional | Required if you want ModernTax to fire 8821 signature collection. Skip if you'll upload a pre-signed PDF via `/api/intake/8821-pdf`. |
| `callback_url` | no | We'll POST status updates here when the request progresses (8821 signed, IRS queue, completed). |

**Response**

```json
{
  "request_id": "uuid",
  "request_token": "your-loan-12345",
  "status": "pending",
  "entities": [
    { "entity_id": "uuid", "entity_name": "ACME Holdings LLC", "form_type": "1120S", "years": ["2022", "2023", "2024"], "status": "pending" }
  ],
  "usage": { "used": 47, "remaining": 953, "limit": 1000 }
}
```

---

### `GET /api/intake/transcript?token=<request_token>` — poll for results

Returns the current status of every entity in a request, plus signed
URLs for any delivered transcripts and a compliance summary.

**Response (in-progress)**

```json
{
  "request_id": "your-loan-12345",
  "status": "pending",
  "request_status": "irs_queue",
  "created_at": "2026-05-08T14:00:00Z",
  "completed_at": null,
  "entities": [
    {
      "entity_id": "uuid",
      "entity_name": "ACME Holdings LLC",
      "tid": "12-3456789",
      "tid_kind": "EIN",
      "form_type": "1120S",
      "years": ["2022", "2023", "2024"],
      "status": "irs_queue",
      "signed_8821_url": "https://...signed-1h-expiry...",
      "transcript_urls": [],
      "transcript_html_urls": [],
      "compliance": null,
      "completed_at": null
    }
  ]
}
```

**Response (completed)**

```json
{
  "request_id": "your-loan-12345",
  "status": "completed",
  "request_status": "completed",
  "completed_at": "2026-05-09T10:32:11Z",
  "entities": [
    {
      "entity_id": "uuid",
      "entity_name": "ACME Holdings LLC",
      "tid": "12-3456789",
      "form_type": "1120S",
      "years": ["2022", "2023", "2024"],
      "status": "completed",
      "signed_8821_url": "https://...",
      "transcript_urls": [
        "https://...signed-1h-expiry/2022-record-of-account.pdf",
        "https://...signed-1h-expiry/2023-record-of-account.pdf",
        "https://...signed-1h-expiry/2024-record-of-account.pdf"
      ],
      "transcript_html_urls": ["https://..."],
      "compliance": {
        "severity": "WARNING",
        "flags": [
          { "type": "BALANCE_DUE", "severity": "WARNING", "message": "Account balance: $4,287.21" }
        ],
        "financials": {
          "grossReceipts": 1240000,
          "totalIncome": 1180000,
          "totalDeductions": 980000,
          "totalTax": 42000,
          "accountBalance": 4287.21,
          "accruedInterest": 0,
          "accruedPenalty": 0
        },
        "recent_transactions": [
          { "code": "150", "explanation": "Tax return filed", "date": "2024-04-12", "amount": "42000" },
          { "code": "766", "explanation": "Credit", "date": "2024-04-15", "amount": "-2000" }
        ]
      },
      "completed_at": "2026-05-09T10:32:11Z"
    }
  ]
}
```

**Severity values:** `"CRITICAL"`, `"WARNING"`, `"CLEAN"`. The
overall severity is the max across all per-form compliance entries.
Recent transactions are capped to the 10 most recent across all
years/forms, sorted descending by date.

---

### `POST /api/intake/8821-pdf` — upload a pre-signed 8821 PDF

For partners who collect borrower signatures via their own DocuSign
or wet-sign workflow. Skips the ModernTax-managed Dropbox Sign flow
entirely — the entity advances straight to `8821_signed`.

**Request** (`multipart/form-data`)

| Form field | Required | Notes |
|---|---|---|
| `file` | yes | The signed PDF (`application/pdf`, max 10 MB). Magic-byte verified server-side. |
| `request_token` | yes | The token used to create the parent request. |
| `entity_name` | conditional | Required if request has > 1 entity (and `entity_id` not provided). |
| `entity_id` | conditional | ModernTax UUID (preferred when known). |
| `years` | no | Override the entity's existing years. Format: `"2022,2023,2024"` or `"2022-2024"`. Range 1990–2028. |
| `form_type` | no | Override form type. Validated against `tid_kind`. |

**Response**

```json
{
  "success": true,
  "entity": {
    "id": "uuid",
    "name": "ACME Holdings LLC",
    "status": "8821_signed",
    "signed_8821_url": "https://...signed-1h-expiry...",
    "years": ["2022", "2023", "2024"],
    "form_type": "1120S"
  }
}
```

**Error responses**

| Status | Body | Meaning |
|---|---|---|
| 400 | `{ "error": "file does not appear to be a PDF (missing %PDF- header)" }` | File magic-byte check failed. |
| 400 | `{ "error": "file too large (max 10485760 bytes)" }` | Exceeds 10 MB. |
| 404 | `{ "error": "request_token not found for your account" }` | Token doesn't exist or belongs to another client. |
| 404 | `{ "error": "entity not found in request" }` | `entity_name` / `entity_id` doesn't match anything in the request. |
| 409 | `{ "error": "multiple entities named \"...\" — pass entity_id", "entity_ids": [...] }` | Disambiguation required. |

---

### `POST /api/intake/monitoring` — enroll an entity in ongoing monitoring

After a request is created (or completed), enroll one of its entities
in recurring transcript pulls.

**Request** (JSON)

```json
{
  "request_token":         "your-loan-12345",
  "entity_name":           "ACME Holdings LLC",
  "frequency":             "annual",
  "skip_initial_pull":     true,
  "expires_at":            "2031-05-09",
  "next_pull_date":        "2027-04-15"
}
```

| Field | Required | Notes |
|---|---|---|
| `request_token` | yes | Parent request token. |
| `entity_name` OR `entity_id` | yes | Which entity to enroll. |
| `frequency` | yes | `"weekly"`, `"monthly"`, `"quarterly"`, `"annual"`, or `"custom"`. |
| `custom_interval_days` | conditional | Required if `frequency=="custom"`. |
| `skip_initial_pull` | no | Default `false`. Set `true` to enroll without firing an immediate expert pull (use for portfolio management of brand-new entities with no tax records yet). |
| `expires_at` | no | ISO date. Subscription auto-cancels after this. |
| `next_pull_date` | no | Override the computed next-pull date. |

**Response**

```json
{
  "success": true,
  "subscription": {
    "id": "uuid",
    "entity_id": "uuid",
    "entity_name": "ACME Holdings LLC",
    "frequency": "annual",
    "next_pull_date": "2027-04-15",
    "expires_at": "2031-05-09",
    "status": "active"
  },
  "immediate_pull": null,
  "skipped_initial_pull": true
}
```

When `skip_initial_pull=false` (default), `immediate_pull` is populated:

```json
"immediate_pull": {
  "assignment_id": "uuid",
  "sla_deadline": "2026-05-11T10:00:00Z",
  "status": "expert_assigned"
}
```

**Idempotency:** if the entity already has an active or paused
subscription, the endpoint returns `409 Conflict` with the existing
subscription. Cancel the old one (via `PATCH /api/monitoring`,
cookie-auth admin only — TODO: partner version) before creating a new
one with different settings.

---

### `POST /api/intake/8821` — bulk metadata for ModernTax-managed signing

Use this when you want ModernTax to handle the signature collection
flow (Dropbox Sign). Submit CSV/Excel or JSON describing entities;
ModernTax sends signature requests to the listed signers, then
proceeds with IRS retrieval automatically.

**Request** (multipart `file` with CSV/XLSX, or JSON `{ entities: [...] }`)

CSV columns: `entity_name`, `tid`, `tid_kind`, `email`, `signer_first_name`,
`signer_last_name`, `years`, `address`, `city`, `state`, `zip`, `form_type` (optional).

**Response**

```json
{
  "request_id": "uuid",
  "entities_created": 12,
  "signature_requests_sent": 12,
  "status": "8821_sent"
}
```

---

### `POST /api/webhook/employment-intake` — submit employment-verification request

For employment / income verification orders (separate product from
transcript orders). See product docs for the payload schema.

### `GET /api/webhook/employment-result?token=<request_token>` — poll for results

Mirrors `GET /api/intake/transcript` but returns parsed
`employment_data` instead of transcripts.

### `PATCH /api/webhook/employment-result?token=<request_token>` — push results back

For ModernTax internal use — partners typically receive results via
the `callback_url` you provided at request creation, not by PATCHing
themselves.

### `GET /api/public/status` — system health check

No auth required. Returns `{ "status": "ok" }` if the API is healthy.
Use this for monitoring; it's safe to call frequently.

---

## Webhooks (push-style result delivery)

If you provide `callback_url` at request creation, ModernTax POSTs
status updates as the request progresses. We retry up to 5 times with
exponential backoff (1m, 5m, 30m, 2h, 12h) on non-2xx responses.

**Headers**

```
content-type: application/json
x-moderntax-signature: <hex sha256 hmac of body, key = your webhook secret>
x-moderntax-event:     transcript.completed | transcript.failed | 8821.signed | irs.queued | monitoring.pulled
```

Verify the signature constant-time before processing. Body shape
mirrors the corresponding `GET /api/intake/transcript` response for
that entity.

---

## Pricing & quotas

API customers are billed monthly via ACH (Mercury) or Stripe at the
rates negotiated for your account. Default tier:

| Item | Rate |
|---|---|
| Transcript pull (per entity, includes 3 years record-of-account + return transcript) | $39.99 |
| Monitoring enrollment (one-time per entity) | $19.99 |
| Monitoring per-pull (only billed when fresh transcripts are delivered, not on no-record-found) | $59.98 |
| Entity-transcript pre-validation (pre-flight election-status check) | $19.99 |
| Setup fee (one-time) | $2,500 |
| Monthly minimum | 10 transcript pulls · 10 monitored accounts |

Volume discounts above 100 pulls/month are available — contact sales.

---

## Compliance & security

- SOC 2 Type I: complete. Type II audit in progress (Q3 2026 target).
- Data encrypted in transit (TLS 1.3) and at rest (Postgres TDE +
  pgcrypto-encrypted SSN/DOB columns for practitioner credentials).
- API keys SHA-256 hashed; constant-time verified.
- Per-tenant storage isolation enforced via Postgres Row-Level
  Security on the `uploads` bucket.
- Audit log records every partner request and result fetch with
  client identity, timestamp, and request token.
- Tax data retention defaults to 5 years post-loan-close; configurable
  per account.

For SOC 2 evidence requests, vendor questionnaires, or pen-test
reports, email `security@moderntax.io`.

---

## Versioning

This document describes the `v1` API surface. Breaking changes will
land at `/api/v2/...`; existing endpoints remain stable.

Last updated: 2026-05-09.
