/**
 * Knowledge base injected into the processor-AI system prompt.
 *
 * This is intentionally not a vector store — it's a curated, narrow set
 * of authoritative answers for the 80% of questions processors actually
 * ask. The AI gets the FAQ as context and is instructed to:
 *   1. Answer from the KB if there's a clear match
 *   2. Mark confidence "low" + recommend escalation if the question
 *      isn't covered by the KB
 *   3. Never fabricate IRS procedure or fee details
 *
 * Add Q&As here as Matt resolves them by email. Eventually a Phase 2
 * "promote past resolved question to FAQ" admin tool keeps this fresh
 * without code edits.
 */

export interface FaqEntry {
  topic: string;
  question: string;
  answer: string;
  /** Hard-flag scenarios where the AI should ALWAYS escalate, even with a partial match. */
  must_escalate?: boolean;
}

export const PROCESSOR_FAQ: FaqEntry[] = [
  // ───────────────────────────────────────────────────────────────────
  // 8821 form questions
  // ───────────────────────────────────────────────────────────────────
  {
    topic: '8821 / Name field',
    question: 'Can I add "Mrs." (or any honorific) to the taxpayer name on the 8821?',
    answer:
      'No — do NOT add Mrs./Mr./Dr. or any prefix to the taxpayer Name field. The IRS matches the 8821 against their records using exact-match on Name, and their database stores names without honorifics (pulled from SSA / IRS account file). A "Mrs. Geeta P Joshi" submission against an IRS record of "Geeta P Joshi" will fail name-mismatch and bounce the form (2-4 week resubmission delay). Use the legal name exactly as it appears on the taxpayer\'s most recent return.',
  },
  {
    topic: '8821 / Name field',
    question: 'What if the taxpayer goes by a nickname or middle name on documents?',
    answer:
      'Use the name as it appears on the most recent filed tax return — that\'s what IRS records reflect. Nicknames (e.g., "Bob" for "Robert") will cause name-mismatch rejection. If the taxpayer wants their preferred name shown elsewhere, that goes in the signature block, never the printed Name field.',
  },
  {
    topic: '8821 / EIN vs SSN',
    question: 'Should I use the SSN or EIN on the 8821 for a single-member LLC?',
    answer:
      'Depends on how the LLC files. If it\'s a disregarded entity filing on the owner\'s 1040 (Schedule C), use the owner\'s SSN — the IRS account is keyed on the SSN, not the LLC EIN. If the LLC has elected S-Corp or C-Corp taxation (Form 8832 / 2553), use the LLC\'s EIN. When in doubt, check the most recent tax return: the TID printed on the return is the one IRS associates with that taxpayer.',
    must_escalate: false,
  },
  {
    topic: '8821 / Signing party',
    question: 'For a joint individual return, does only one spouse need to sign the 8821, or both?',
    answer:
      'Each spouse signs their OWN 8821 — one 8821 per taxpayer. A jointly-filed return covers two taxpayers (two SSNs), and IRS issues two separate transcript files. So if the request involves both spouses, you need two 8821s, one per SSN, each signed by the respective spouse. Don\'t try to combine.',
  },
  {
    topic: '8821 / Designee',
    question: 'Can I change the designee (CAF holder) on a signed 8821?',
    answer:
      'No — once an 8821 is signed by the taxpayer, the designee block is locked. If a different ModernTax expert needs to be the PPS caller (e.g., reassignment), regenerate the 8821 with that expert\'s CAF and re-collect the borrower signature. Use the "Regenerate 8821 w/ expert creds" button on the entity card, then re-send for signature.',
  },
  {
    topic: '8821 / Years',
    question: 'What years can I request on the 8821?',
    answer:
      'IRS Form 8821 authorizes up to seven years of records (current year + six prior). Practical default: include the most recent 3-4 filed years for transcript pulls. If the borrower wants historical (e.g., ERC review 2020-2021), include those quarters specifically. Don\'t exceed seven years from the current tax year.',
  },
  // ───────────────────────────────────────────────────────────────────
  // IRS transcript questions
  // ───────────────────────────────────────────────────────────────────
  {
    topic: 'Transcripts / "No record found"',
    question: 'What does "No record of return filed" on a transcript mean?',
    answer:
      'It means the IRS has no return on file for that tax period. Three common causes: (1) the return was filed under a different name/TID (typo or pre-marriage name), (2) the return was filed but is in processing (recent filings can take 12+ weeks to post), (3) the return genuinely wasn\'t filed. Check the taxpayer\'s most recent return acknowledgment letter and confirm the TID + name match exactly. If the borrower fired a non-traditional fiscal year, period mismatch will also return "no record" — verify FYE before pulling again.',
  },
  {
    topic: 'Transcripts / Fiscal year',
    question: 'How do I pull transcripts for an entity with a non-calendar fiscal year (e.g., 2/28)?',
    answer:
      'Set the entity\'s "Fiscal Year End" field on the request form (intake) or via the admin edit panel. The expert\'s PPS call requests transcripts by tax_period in YYYYMM format — a 2/28 FYE entity\'s 2024 tax year is requested as 202402, not 202412. If you don\'t set FYE and the IRS only has 2/28 records for the entity, the calendar-year (202412) pull will return "no record" — that\'s the Katie Lent / Troch-Mc Neil pattern.',
  },
  {
    topic: 'Transcripts / ERC',
    question: 'Which transcripts cover the ERC eligibility window?',
    answer:
      'ERC covers Q2 2020 through Q4 2021 (Q4 2021 is RSB-only). Pull Form 941 quarterly transcripts for each quarter in the window: 202006, 202009, 202012, 202103, 202106, 202109, 202112. The Account Transcript (not Tax Return Transcript) is what shows TC 766 (ERC credit) + TC 846 (refund issued) + TC 740 (refund returned undelivered). Use the ERC Refund Delivery section on the compliance-status page to see if any refunds came back as undelivered — those are recoverable via Form 3911.',
  },
  // ───────────────────────────────────────────────────────────────────
  // Workflow / process
  // ───────────────────────────────────────────────────────────────────
  {
    topic: 'Workflow / Status meanings',
    question: 'What do the entity statuses mean?',
    answer:
      'submitted = request received, 8821 not yet sent. 8821_sent = Form 8821 emailed to borrower for signature (via Dropbox Sign). 8821_signed = borrower signed; entity is ready for expert assignment. irs_queue = assigned to an expert; awaiting their PPS call. processing = expert is on the IRS line. completed = transcripts pulled and uploaded. failed = something blocked completion (see outcome_notes on the entity for reason).',
  },
  {
    topic: 'Workflow / 8821 not arriving',
    question: 'The borrower didn\'t receive the 8821 email — what should I do?',
    answer:
      'First, check the entity\'s "signer_email" field is correct (no typos). Then check the borrower\'s spam folder — Dropbox Sign envelopes sometimes land there. If still missing, click "Resend 8821" on the entity card; that re-fires the Dropbox Sign envelope. If after that they still haven\'t received it within 30 min, the issue is usually email-domain reputation — ask the borrower for a different email (gmail, outlook, etc.) and update signer_email before resending.',
  },
  // ───────────────────────────────────────────────────────────────────
  // Billing / fees
  // ───────────────────────────────────────────────────────────────────
  {
    topic: 'Billing / Rates',
    question: 'What does ModernTax charge per entity?',
    answer:
      'Rates vary by client contract. The standard PAYG (pay-as-you-go) rate is shown on your client\'s billing settings page. Subscription clients have a monthly cap with an overage rate. If a specific entity is invoiced incorrectly, flag it with admin — don\'t guess at the rate.',
    must_escalate: true,
  },
  // ───────────────────────────────────────────────────────────────────
  // Things that ALWAYS need admin (don't AI-answer these)
  // ───────────────────────────────────────────────────────────────────
  {
    topic: 'Anything else',
    question: 'Should I escalate this to admin?',
    answer:
      'Escalate ANY question involving: a specific borrower\'s personal situation (we don\'t want PII in the AI context), legal/tax advice (we\'re not licensed), a billing dispute, an IRS rejection you\'ve never seen before, anything involving Form 3911 / refund recovery / lost-check scenarios. Click "Need a human" on this question and Matt will follow up within a few hours.',
    must_escalate: true,
  },
];

/**
 * Build the system prompt for the Claude API call. The FAQ entries are
 * embedded inline so the model has authoritative context without needing
 * an embeddings/RAG step.
 */
export function buildProcessorSystemPrompt(): string {
  const faq = PROCESSOR_FAQ
    .map((e, i) => `[${i + 1}] TOPIC: ${e.topic}\n  Q: ${e.question}\n  A: ${e.answer}${e.must_escalate ? '\n  (Always escalate for borrower-specific questions on this topic.)' : ''}`)
    .join('\n\n');

  return `You are ModernTax's in-app Q&A assistant for loan processors.

ROLE & TONE:
- You are answering questions from loan processors at SBA lenders and tax pros (e.g., Centerstone, TaxTaker, Clearfirm, Cal Statewide, Banc of California, Growth Corp).
- Be direct, practical, and crisp. Processors are busy and want the right answer in 2-4 sentences. Don't pad with niceties.
- Use plain language. Avoid jargon unless it's standard IRS terminology (TC 150, ERC, 8821, etc.).

WHAT YOU KNOW:
- IRS Form 8821 (Tax Information Authorization) — name fields, signing, designee rules, year limits
- IRS account / return transcripts — tax periods, fiscal years, "no record" causes
- ERC (Employee Retention Credit) — eligibility window Q2 2020 - Q4 2021, transcript codes (TC 766, 846, 740), Form 3911 reissue path
- ModernTax workflow — entity statuses, 8821 signing flow, expert assignment, IRS PPS calls
- General processor operations within the ModernTax portal

WHAT YOU DON'T KNOW (always escalate):
- Borrower-specific situations involving PII (SSN, EIN, financial detail)
- Legal or tax advice — you're not a CPA, EA, or attorney
- Billing disputes or specific contract rate questions
- Novel IRS procedures or rejections not in the FAQ below
- Anything involving Form 3911, refund recovery, or lost-check workflows beyond pointing to the right tool

OUTPUT FORMAT (CRITICAL — your response MUST be JSON only, no prose wrapper):
{
  "answer": "your 2-4 sentence answer",
  "confidence": "high" | "medium" | "low",
  "should_escalate": true | false,
  "escalation_reason": "<reason if should_escalate=true, else null>"
}

RULES:
- confidence="high" when the question is covered cleanly by the FAQ below
- confidence="medium" when partially covered or you're inferring from related FAQ entries
- confidence="low" → always also set should_escalate=true with a reason
- ANY question containing borrower PII (a specific name, SSN, EIN, dollar amount on a specific account) → escalate immediately with reason "contains borrower-specific PII"
- NEVER fabricate IRS procedure, fee amounts, or filing deadlines

═══════════════════════════════════════════════════════════════════════════════
KNOWLEDGE BASE (authoritative — answer FROM this when possible):
═══════════════════════════════════════════════════════════════════════════════

${faq}

═══════════════════════════════════════════════════════════════════════════════

Now respond to the processor's question. JSON only.`;
}
