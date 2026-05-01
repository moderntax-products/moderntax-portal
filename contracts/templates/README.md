# MSA Templates - Manual Dropbox Sign Upload Guide

These three PDFs are ready to upload to Dropbox Sign via the web dashboard
([https://app.hellosign.com/home/manage](https://app.hellosign.com/home/manage)) -
no API plan required.

| File | Use for | Status |
|---|---|---|
| `ModernTax_MSA_Centerstone_SBA_Lending_Inc_2026-06-01.pdf` | Centerstone SBA Lending - amended MSA | Tier B selected, $1,000 grandfather clause baked in |
| `ModernTax_MSA_TMC_Financing_LLC_2026-06-01.pdf` | TMC Financing - amended MSA | Tier B selected, $2,500 INV-16 deposit clause baked in |
| `ModernTax_MSA_BLANK_TEMPLATE_2026-06-01.pdf` | Future customer signups | All three tiers visible with empty checkboxes; placeholders for customer fill |

---

## Sending Centerstone (Mathew Paek)

1. **Dropbox Sign dashboard** -> *New Document* -> *Sign or send for signature*
2. **Upload** `ModernTax_MSA_Centerstone_SBA_Lending_Inc_2026-06-01.pdf`
3. **Add signers** in this order:
   - **Signer 1**: `mathew.paek@teamcenterstone.com` (Mathew Paek)
   - **Signer 2** (you, countersigning): `matt@moderntax.io` (Matthew Parker)
4. **Add CC** (read-only copy): `jasmine.kim@teamcenterstone.com` (Jasmine Kim, Centerstone billing contact)
5. **Place signature fields** on page 5 (signature block):
   - **Mathew Paek's signature**: under "Centerstone SBA Lending, Inc." -> "Signature" line
   - **Mathew Paek's date**: "Date: ____________________" line
   - **Matthew Parker's signature**: under "ModernTax, Inc." -> "Signature" line (left column)
   - **Matthew Parker's date**: "Date: ____________________" line (left column)
6. **Subject**: `ModernTax Master Services Agreement - Centerstone SBA Lending`
7. **Message**:
   > Hi Mathew, attached is the amended Master Services Agreement for Centerstone SBA Lending, effective June 1, 2026. This consolidates and supersedes the September 2025 Order Form and standardizes our pricing across customers. Centerstone retains the discounted Tier B rate ($59.98 per TIN) - your prior $1,000 deposit is grandfathered in, no top-up required. Reply to this email or matt@moderntax.io with any questions before signing. Thanks, Matt
8. **Send**.

---

## Sending TMC Financing (Grace Quintin)

1. **Dropbox Sign dashboard** -> *New Document* -> *Sign or send for signature*
2. **Upload** `ModernTax_MSA_TMC_Financing_LLC_2026-06-01.pdf`
3. **Add signers** in order:
   - **Signer 1**: `grace@tmcfinancing.com` (Grace Quintin)
   - **Signer 2** (you): `matt@moderntax.io` (Matthew Parker)
4. **Add CC**: `kisha@tmcfinancing.com` (Kisha)
5. **Place signature fields** on page 5 (same positions as Centerstone, signer names swapped):
   - Grace Quintin's signature + date on the right column
   - Matthew Parker's signature + date on the left column
6. **Subject**: `ModernTax Master Services Agreement - TMC Financing`
7. **Message**:
   > Hi Grace, attached is the amended Master Services Agreement for TMC Financing, effective June 1, 2026. This formalizes our pricing structure with the new add-on fees (entity transcripts, 8821 generation surcharge, account monitoring) at the discounted Tier B rate of $59.98 per TIN. The $2,500 onboarding deposit covered by INV-16 (due May 5) carries forward as your usage credit. Reply to this email or matt@moderntax.io with any questions. Thanks, Matt
8. **Send**.

---

## Using the Blank Template for new signups

`ModernTax_MSA_BLANK_TEMPLATE_2026-06-01.pdf` is customer-agnostic - all three tiers
visible with empty checkboxes, and placeholder text in the customer block.

When a new prospect signs:

1. Open the blank template, fill in:
   - Page 1 preamble: customer name + address
   - §2.1 Service Tier Selection: mark `[X]` next to the chosen tier
   - §2.3 Onboarding Deposit (Tier B only): replace placeholder language with one of:
     - **Standard Tier B**: `Client shall pay an onboarding deposit of $2,500.00 prior to or on the Effective Date. The deposit is applied as credit against Client's first month(s) of usage at the Verification rate of $59.98 per TIN per Section 2.1.B. No further deposit is required after the initial credit is exhausted.`
     - **Tier A or C**: delete the §2.3 paragraph entirely (no deposit applies)
   - §9.4 Notices: customer notice email
   - Signature block: customer signer name + title

2. Save the customized PDF and upload to Dropbox Sign as above.

You can use Pages, Preview, or any PDF editor to fill the placeholders. Or
ask Claude to render a customized version via:

```bash
npx tsx scripts/send-msa.ts <new-customer-shortname>
```

(would require adding the customer block to `scripts/send-msa.ts` first, similar
to the existing `CENTERSTONE` and `TMC` constants).

---

## When budget allows: re-enable programmatic sends

Once the Dropbox Sign API plan is upgraded ([https://app.hellosign.com/api/pricing](https://app.hellosign.com/api/pricing)), the same script that produced these PDFs
can also push them straight into Dropbox Sign via API:

```bash
npx tsx scripts/send-msa.ts all --send
```

This bypasses the manual upload + field placement and triggers signature
requests directly. Standard tier (~$80/mo) covers it. Until then, manual
upload is the path.
