# Email Intake Setup (SendGrid Inbound Parse)

One-time DNS + SendGrid config to enable auto-conversion of processor
emails (CSV + 8821 attached) into portal requests at
`/api/webhook/email-intake`.

Promised to Soobin Song (Centerstone) on 2026-05-26 after her 4/23
email got lost in Matt's inbox. Closes that gap permanently.

## Steps (do in this order)

### 1. Generate the webhook secret + add to Vercel

```bash
# Generate
SECRET=$(openssl rand -hex 24)
echo "$SECRET"

# Add to Vercel production
echo "$SECRET" | vercel env add EMAIL_INTAKE_SECRET production

# Also add to .env.local for local testing
echo "EMAIL_INTAKE_SECRET=\"$SECRET\"" >> .env.local
```

Save the secret — you'll paste it into the SendGrid dashboard in step 3.

### 2. DNS — add MX record for `in.moderntax.io`

Go to your DNS provider (Cloudflare per the CSP we saw in headers).
Add a single MX record:

| Type | Host | Priority | Target | TTL |
|------|------|---------:|--------|-----|
| MX | in (so it becomes `in.moderntax.io`) | 10 | `mx.sendgrid.net` | Auto |

DNS propagation: 5-60 minutes. Verify with `dig MX in.moderntax.io`.

### 3. SendGrid — configure Inbound Parse

1. Go to https://app.sendgrid.com/settings/parse
2. Click "Add Host & URL"
3. Fill in:
   - **Receiving Domain**: `in.moderntax.io`
   - **Destination URL**: `https://portal.moderntax.io/api/webhook/email-intake?secret=PASTE_SECRET_FROM_STEP_1`
   - **Check incoming emails for spam**: ✓ enabled
   - **POST the raw, full MIME message**: ☐ disabled (we want the parsed multipart form)
   - **Skip Send Email Filter**: ☐ disabled (let SendGrid spam-filter)
4. Click Save

### 4. Smoke test

Send a test email from a known portal account (e.g. soobin.song@teamcenterstone.com) to:

```
intake@in.moderntax.io
```

With:
- Subject: `Loan #12345 - Test Company - Tax Transcripts Request`
- Body: any text
- Attachment: a 1-row CSV with the standard column headers

Within 60 seconds the sender should receive a confirmation email titled
*"Re: ... — received & in queue"* and Matt should get an `[Email Intake]`
notification at matt@moderntax.io.

The new request will appear at `/admin/requests/<id>` attributed to the
sender's profile.

## What the webhook does

1. Validates `?secret=` matches `EMAIL_INTAKE_SECRET`
2. Looks up sender by `from` email address against `profiles.email`
3. Parses the first `.csv`/`.xlsx`/`.xls` attachment as entity rows
4. Uploads any `.pdf` attachments to storage, attempts heuristic match
   to entity name (PDFs named like the entity get auto-attached as
   signed 8821s)
5. Creates `requests` row + N `request_entities` rows
6. Sends confirmation back to sender
7. Notifies matt@moderntax.io

## Bounce paths (sender gets a friendly error email)

- Sender email not in `profiles` → "ask your team admin to add you"
- Sender has no `client_id` → forwarded to Matt to fix
- No CSV attached → reminder to attach with link to the sample format
- CSV parse failed → error detail + retry instruction
- CSV had no data rows → reminder to include entities
- CSV validation failed (missing legal_name/tid) → row-specific list

## Promote the new address to processors

After step 4 smoke test passes, email known processors at each client:

```
Subject: New direct intake address — skip the manual triage

Hi {first_name},

Quick FYI — you can now submit transcript requests by emailing
intake@in.moderntax.io directly with:

1. Subject line including the loan number (e.g., "Loan #18032 - ...")
2. CSV/Excel attachment with the standard column headers
3. (Optional) any pre-signed 8821 PDFs

You'll get a confirmation back within a minute and the request lands
in the portal automatically — no waiting on Matt to triage manually.

Same emails to matt@moderntax.io still work; this is just faster.
```

Send to these processors immediately:
- soobin.song@teamcenterstone.com
- mathew.paek@teamcenterstone.com (FYI — he's the manager)
- robin.kim@teamcenterstone.com (active processor per recent activity)
- accountspayable@calstatewide.com (forward to Sonja/team)

## Future enhancements (not blocking initial launch)

- **Subject parsing for client routing**: currently relies on sender
  profile's `client_id`. Could extract client name from subject for
  cross-client processors.
- **Body-based loan number override**: subject is checked first;
  could enhance to prefer body-stated number if subject is vague.
- **Multi-CSV per email**: currently only first CSV is processed.
  Could chunk into multiple requests.
- **Async processing**: SendGrid waits for our 200; long-running CSV
  parses risk webhook timeout. If >60 sec becomes common, switch to
  202-accept + queue for background processing.
- **HMAC signature**: SendGrid supports request signing. Current
  `?secret=` is fine for v1 but signature is more robust against
  URL-secret leakage.
