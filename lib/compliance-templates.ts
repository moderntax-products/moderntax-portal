/**
 * Borrower outreach templates for compliance flags.
 *
 * When a transcript pull surfaces a compliance issue (unfiled return,
 * lien, balance due, election problem, etc.) the processor or manager
 * sends one of these templates to the borrower from the /compliance
 * page. Every template ends with a Calendly link so the borrower can
 * book a time with the ModernTax team to resolve.
 *
 * Robert/Enterprise Bank Apr 27 ask: "We're trying to tell them exactly
 * how to resolve it because we need the issue resolved." This shifts the
 * resolution loop from manual lender→borrower back-and-forth to a guided
 * borrower-direct flow with explicit IRS-suggested next steps.
 *
 * Adding a new template:
 *   1. Add a new entry to TEMPLATES below with subject + body markdown.
 *   2. The /api/compliance/send-template endpoint renders body markdown
 *      → HTML and substitutes the {{borrower_name}}, {{entity_name}},
 *      {{flag_message}}, {{book_url}} variables.
 */

export interface ComplianceTemplate {
  id: string;
  /** Flag types this template applies to (matches lib/compliance-screening flag.type) */
  flag_types: string[];
  display_name: string;
  short_description: string;
  subject: string;
  body_markdown: string;
}

const BOOK_URL = 'https://cal.com/moderntax/15min'; // can be overridden per-client later

export const TEMPLATES: ComplianceTemplate[] = [
  {
    id: 'unfiled_return',
    flag_types: ['UNFILED'],
    display_name: 'Unfiled return — IRS has no record',
    short_description: 'IRS shows no return filed for the requested year. Borrower needs to file or confirm filing.',
    subject: 'Action needed: IRS has no record of your tax return filing',
    body_markdown: `Hi {{borrower_name}},

We pulled the IRS transcript for **{{entity_name}}** as part of the SBA loan due diligence and the IRS has no record of a return being filed for the year(s) we requested.

This is one of three scenarios:
1. **The return was never filed.** You'll need to file it now to keep the loan moving forward.
2. **The return was filed but not yet posted to the IRS system.** This can take 6-8 weeks for paper-filed returns. We can request a confirmation call with the IRS.
3. **The return was filed under a different EIN/SSN.** This happens after entity restructuring (sole prop → LLC, LLC → S-Corp election, etc.) and requires the IRS to merge records.

**The fastest way to resolve this is a 15-minute call with our team.** We'll review your filing history, identify which scenario applies, and give you a specific action plan with IRS contact instructions.

[Book a call now →]({{book_url}})

If you've already filed, please reply with the date you filed and we'll pursue scenario 2 or 3 on your behalf.

Thanks,
The ModernTax team`,
  },
  {
    id: 'wrong_election',
    flag_types: ['UNFILED', 'SFR'],
    display_name: 'Wrong tax election (S-Corp / C-Corp / LLC mismatch)',
    short_description: 'Form filed under one entity classification but IRS expects another. Common after S-Corp election or LLC restructure.',
    subject: 'Action needed: Tax election mismatch on your IRS records',
    body_markdown: `Hi {{borrower_name}},

We pulled the IRS transcript for **{{entity_name}}** for the SBA loan and found a tax election issue:

**{{flag_message}}**

This usually means one of these is true:
1. You filed an **S-Corp election (Form 2553)** but the IRS hasn't acknowledged it yet, so they're expecting a 1120 (C-Corp) instead of an 1120-S.
2. You filed as an LLC pass-through but the IRS has the entity classified differently.
3. Your CPA filed the wrong form for the entity type.

**Why it matters for your SBA loan:** the lender needs your transcripts to match your loan application, and a form mismatch will block underwriting. These take 30-90 days to resolve through the IRS without our help — much faster with a guided plan.

**Book 15 minutes with our team and we'll:**
- Pull your **Entity Transcript** to confirm what the IRS has on file
- Identify exactly which form needs to be corrected, refiled, or supplemented
- Give you the IRS contact info + the script to use to fast-track the fix

[Book a call →]({{book_url}})

Thanks,
The ModernTax team`,
  },
  {
    id: 'balance_due',
    flag_types: ['BALANCE_DUE'],
    display_name: 'Balance owed to IRS',
    short_description: 'Borrower has an outstanding balance with the IRS. May need installment agreement or payment plan to clear the SBA hurdle.',
    subject: 'Action needed: IRS shows an outstanding balance for {{entity_name}}',
    body_markdown: `Hi {{borrower_name}},

We pulled the IRS transcripts for **{{entity_name}}** as part of your SBA loan and found an outstanding balance with the IRS:

**{{flag_message}}**

For SBA approval, this balance needs to either be paid in full OR set up on an active installment agreement. **Most lenders won't fund a loan with an open IRS balance left unaddressed.**

You have three paths:
1. **Pay in full** — the cleanest solution if the balance is small or you have liquidity.
2. **Installment agreement** — IRS approves these for balances under $50K with a 72-month term, and they're typically approved within 30 days. Once active, the SBA file is good.
3. **Offer in Compromise (OIC)** — for balances you genuinely can't pay; takes 6-12 months but eliminates the debt.

**Schedule 15 minutes with our team** and we'll review your transcript, explain exactly which path your case fits into, and connect you with the right contact at IRS to set it up:

[Book a call →]({{book_url}})

Thanks,
The ModernTax team`,
  },
  {
    id: 'lien_levy',
    flag_types: ['LIEN', 'LEVY', 'COLLECTION'],
    display_name: 'Federal tax lien or levy on file',
    short_description: 'IRS has filed a lien, executed a levy, or has active collection action. Often requires release before underwriting approval or funding.',
    subject: 'Action needed: Federal tax lien/levy on your IRS account',
    body_markdown: `Hi {{borrower_name}},

We pulled the IRS transcript for **{{entity_name}}** and found an active lien or levy:

**{{flag_message}}**

This will block your SBA loan from closing unless we resolve it before underwriting. Lien releases typically take 30-90 days through the IRS — but with a structured release request, we can usually fast-track it.

Two paths to a release:
1. **Pay the underlying balance** — IRS releases the lien within 30 days once the balance hits zero.
2. **Subordination request (Form 14134)** — keeps the lien but moves the SBA loan into senior position. Faster path; doesn't require paying the balance off.

**Book 15 minutes with our team** to review your case and pick the right path:

[Book a call →]({{book_url}})

Thanks,
The ModernTax team`,
  },
  {
    id: 'audit_examination',
    flag_types: ['AUDIT'],
    display_name: 'IRS audit / examination active',
    short_description: 'IRS is examining a return. May need to wait for examination to close or pursue alternate documentation.',
    subject: 'Action needed: IRS examination open on your account',
    body_markdown: `Hi {{borrower_name}},

We pulled the IRS transcript for **{{entity_name}}** and the account shows an active examination:

**{{flag_message}}**

This doesn't necessarily block your SBA loan, but the lender will need to know the status and likely timeline. Most exams resolve within 6-12 months but can extend.

**Schedule 15 minutes with our team** and we'll:
- Pull the full record-of-account to see exactly what the IRS is examining
- Explain whether the loan can proceed with disclosure or needs to wait
- Connect you with the examiner's office if you need an updated status letter

[Book a call →]({{book_url}})

Thanks,
The ModernTax team`,
  },
  {
    id: 'no_record_found_general',
    flag_types: ['UNFILED', 'NO_RECORD'],
    display_name: 'No record found — general',
    short_description: 'Generic "no IRS records exist" template for cases where we pulled and found nothing. Audit-defense documentation already filed.',
    subject: '{{entity_name}} — no IRS records found for the requested year',
    body_markdown: `Hi {{borrower_name}},

We pulled the IRS transcripts for **{{entity_name}}** as part of your SBA loan due diligence and the IRS reported no records for the requested tax year(s).

This is fully documented in our system for the lender's audit defense — we have a paper trail showing the pull was attempted on the correct dates.

**To move the loan forward**, we need to confirm one of these is true:
- The return was filed but hasn't yet posted to IRS systems (can take 6-8 weeks).
- The return was filed under a different EIN/SSN (after entity restructure or election change).
- The return was never filed and needs to be.

**The fastest path:** [book a 15-minute call with our team]({{book_url}}). We'll figure out which scenario applies and give you a specific action plan.

Thanks,
The ModernTax team`,
  },
];

/**
 * Pick the best template suggestion for a set of flags. Returns the
 * highest-priority template whose flag_types intersects the entity's flags.
 */
export function suggestTemplate(entityFlags: { type: string }[]): ComplianceTemplate | null {
  const flagTypeSet = new Set(entityFlags.map(f => f.type));
  // Priority order: lien/levy (most urgent) > balance_due > audit > unfiled > catch-all
  const priorityOrder = [
    'lien_levy',
    'balance_due',
    'audit_examination',
    'wrong_election',
    'unfiled_return',
    'no_record_found_general',
  ];
  for (const templateId of priorityOrder) {
    const tmpl = TEMPLATES.find(t => t.id === templateId);
    if (!tmpl) continue;
    if (tmpl.flag_types.some(ft => flagTypeSet.has(ft))) return tmpl;
  }
  return null;
}

/**
 * Render a template's body for a specific entity. Substitutes
 * {{borrower_name}}, {{entity_name}}, {{flag_message}}, {{book_url}}.
 * Returns plain markdown — caller can convert to HTML before sending.
 */
export function renderTemplate(
  template: ComplianceTemplate,
  vars: { borrower_name?: string; entity_name: string; flag_message?: string; book_url?: string },
): { subject: string; body_markdown: string } {
  const sub = (s: string) => s
    .replace(/\{\{borrower_name\}\}/g, vars.borrower_name || 'there')
    .replace(/\{\{entity_name\}\}/g, vars.entity_name)
    .replace(/\{\{flag_message\}\}/g, vars.flag_message || 'See attached IRS transcript for details.')
    .replace(/\{\{book_url\}\}/g, vars.book_url || BOOK_URL);
  return {
    subject: sub(template.subject),
    body_markdown: sub(template.body_markdown),
  };
}

/**
 * Convert markdown body to HTML for SendGrid. Handles paragraphs,
 * bold (**), inline links, and plain bullet lists.
 */
export function markdownToHtml(md: string): string {
  return md
    .split(/\n\n+/)
    .map(block => {
      const trimmed = block.trim();
      if (!trimmed) return '';
      // Bullet list: lines starting with "- " or "1. "
      if (/^([-*]|\d+\.)\s/.test(trimmed)) {
        const items = trimmed.split('\n').map(line => {
          const stripped = line.replace(/^([-*]|\d+\.)\s+/, '');
          return `<li>${inline(stripped)}</li>`;
        }).join('');
        const ordered = /^\d+\.\s/.test(trimmed);
        return ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`;
      }
      return `<p>${inline(trimmed)}</p>`;
    })
    .join('\n');
}

function inline(s: string): string {
  return s
    // Bold
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    // Markdown links [text](url)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    // Newlines within a block become <br>
    .replace(/\n/g, '<br>');
}
