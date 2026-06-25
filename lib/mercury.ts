/**
 * Mercury API Client
 *
 * Wraps the Mercury REST API for Accounts Receivable (customer + invoice
 * management). We lean on Mercury to handle invoice email delivery, ACH
 * debit collection, and the payer-facing pay page. ModernTax stores the
 * Mercury customer/invoice IDs alongside our own invoice rows so usage
 * reconciliation remains fully tied to our portal data model.
 *
 * Base URL:   https://api.mercury.com/api/v1
 * Auth:       `Authorization: Bearer {MERCURY_API_KEY}` — the token should
 *             already include the `secret-token:` prefix Mercury issues.
 *
 * Environment:
 *   MERCURY_API_KEY              required  — full secret-token string
 *   MERCURY_DESTINATION_ACCOUNT  required  — Mercury account UUID that
 *                                            incoming invoice payments deposit into
 */

const MERCURY_API_BASE = 'https://api.mercury.com/api/v1';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MercuryCustomer {
  id: string;
  name: string;
  email: string;
  address?: MercuryCustomerAddress | null;
  deletedAt?: string | null;
}

export interface MercuryCustomerAddress {
  address1: string;
  address2?: string | null;
  city: string;
  region: string;     // ISO state code or region name
  postalCode: string;
  country: string;    // ISO 3166-1 alpha-2, e.g. "US"
}

export interface MercuryCustomerCreateInput {
  name: string;
  email: string;
  address?: MercuryCustomerAddress & { name: string }; // Mercury address input includes a `name` field
}

export interface MercuryLineItem {
  name: string;
  unitPrice: number;       // dollars, e.g. 79.98
  quantity: number;
  salesTaxRate?: number | null;
}

export interface MercuryInvoiceCreateInput {
  customerId: string;
  destinationAccountId: string;
  dueDate: string;          // YYYY-MM-DD
  invoiceDate: string;      // YYYY-MM-DD
  invoiceNumber?: string | null;
  lineItems: MercuryLineItem[];
  ccEmails?: string[];
  creditCardEnabled?: boolean;
  achDebitEnabled?: boolean;
  useRealAccountNumber?: boolean;
  internalNote?: string | null;
  payerMemo?: string | null;
  poNumber?: string | null;
  sendEmailOption?: 'SendNow' | 'DontSend';
  servicePeriodStartDate?: string | null;
  servicePeriodEndDate?: string | null;
}

export interface MercuryInvoice {
  id: string;
  invoiceNumber: string;
  customerId: string;
  destinationAccountId: string;
  dueDate: string;
  invoiceDate: string;
  amount: number;
  status: 'Unpaid' | 'Paid' | 'Cancelled' | 'Processing';
  slug: string;
  ccEmails: string[];
  lineItems: MercuryLineItem[];
  achDebitEnabled: boolean;
  creditCardEnabled: boolean;
  useRealAccountNumber: boolean;
  createdAt: string;
  updatedAt: string;
  canceledAt?: string | null;
  internalNote?: string | null;
  payerMemo?: string | null;
  poNumber?: string | null;
  servicePeriodStartDate?: string | null;
  servicePeriodEndDate?: string | null;
}

export interface MercuryAccount {
  id: string;
  name: string;
  nickname?: string | null;
  kind: string;              // "checking" | "savings" | etc.
  currentBalance: number;
  availableBalance: number;
  accountNumber?: string | null;
  routingNumber?: string | null;
  status: string;
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

function getApiKey(): string {
  const key = process.env.MERCURY_API_KEY;
  if (!key) throw new Error('MERCURY_API_KEY not configured');
  return key;
}

async function mercuryFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${MERCURY_API_BASE}${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${getApiKey()}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Mercury ${init.method || 'GET'} ${path} ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export async function listMercuryAccounts(): Promise<MercuryAccount[]> {
  const data = await mercuryFetch<{ accounts: MercuryAccount[] }>('/accounts');
  return data.accounts || [];
}

export function getDestinationAccountId(): string {
  const id = process.env.MERCURY_DESTINATION_ACCOUNT;
  if (!id) throw new Error('MERCURY_DESTINATION_ACCOUNT not configured — set to Mercury account UUID for incoming invoice payments');
  return id;
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export async function createMercuryCustomer(input: MercuryCustomerCreateInput): Promise<MercuryCustomer> {
  return mercuryFetch<MercuryCustomer>('/ar/customers', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function listMercuryCustomers(limit = 1000): Promise<MercuryCustomer[]> {
  const data = await mercuryFetch<{ customers: MercuryCustomer[] }>(`/ar/customers?limit=${limit}`);
  return data.customers || [];
}

/**
 * Find existing Mercury customer by email or create a new one. Caller
 * provides enough data to create if missing.
 */
export async function findOrCreateMercuryCustomer(
  input: MercuryCustomerCreateInput,
): Promise<MercuryCustomer> {
  const customers = await listMercuryCustomers();
  const existing = customers.find(
    c => c.email?.toLowerCase() === input.email.toLowerCase() && !c.deletedAt,
  );
  if (existing) return existing;
  return createMercuryCustomer(input);
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

/**
 * Create and (by default) email an invoice. Mercury handles the email
 * delivery and hosts the payer-facing pay page. ACH debit is enabled so
 * the payer enters their bank info at pay time — we never touch ACH
 * credentials on our side.
 */
export async function createMercuryInvoice(input: MercuryInvoiceCreateInput): Promise<MercuryInvoice> {
  // Mandatory safe defaults: ACH on, credit card off (no Stripe), virtual
  // account numbers, send email immediately.
  const body: MercuryInvoiceCreateInput = {
    achDebitEnabled: true,
    creditCardEnabled: false,
    useRealAccountNumber: false,
    sendEmailOption: 'SendNow',
    ccEmails: [],
    ...input,
  };
  return mercuryFetch<MercuryInvoice>('/ar/invoices', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function listMercuryInvoices(limit = 1000): Promise<MercuryInvoice[]> {
  const data = await mercuryFetch<{ invoices: MercuryInvoice[] }>(`/ar/invoices?limit=${limit}&order=desc`);
  return data.invoices || [];
}

export function getMercuryInvoicePdfUrl(slug: string): string {
  // Per Mercury docs: GET /api/v1/ar/invoices/{slug}/pdf returns the PDF URL.
  // We expose the stable slug-based path so callers can link directly.
  return `${MERCURY_API_BASE}/ar/invoices/${slug}/pdf`;
}

export function getMercuryPayUrl(slug: string): string {
  return `https://app.mercury.com/pay/${slug}`;
}

// ---------------------------------------------------------------------------
// Payouts — recipients + send-money (expert payroll). APPROVAL-GATED: a
// send-money request lands in Mercury's approval queue; a human approves it
// in the Mercury app before any money moves. We never create or store bank
// details — Mercury holds them on the recipient (recipient-invite flow).
// ---------------------------------------------------------------------------

export interface MercuryRecipient {
  id: string;
  name: string;
  status: string;
  emails?: string[];
  defaultPaymentMethod?: string | null;
  dateLastPaid?: string | null;
}

/** All recipients on the Mercury org (used to match experts by name/email). */
export async function listMercuryRecipients(limit = 1000): Promise<MercuryRecipient[]> {
  const data = await mercuryFetch<{ recipients: MercuryRecipient[] }>(`/recipients?limit=${limit}`);
  return data.recipients || [];
}

/**
 * Create a Mercury recipient with just a name + email — Mercury only requires
 * `name` and `emails`; bank details are optional, so the expert adds their own
 * banking info in Mercury (we never store it). Used to AUTO-INVITE each expert.
 */
export async function createMercuryRecipient(name: string, email: string): Promise<MercuryRecipient> {
  return mercuryFetch<MercuryRecipient>('/recipients', {
    method: 'POST',
    body: JSON.stringify({ name, emails: [email] }),
  });
}

const normName = (s: string | null | undefined) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Find the Mercury recipient whose email or name matches an expert. */
export function matchRecipient(
  recipients: MercuryRecipient[],
  expertName: string | null,
  expertEmail: string | null,
): MercuryRecipient | null {
  const n = normName(expertName);
  const e = (expertEmail || '').toLowerCase().trim();
  return (
    recipients.find(r => e && (r.emails || []).some(x => x.toLowerCase().trim() === e)) ||
    (n ? recipients.find(r => normName(r.name) === n) : null) ||
    null
  );
}

/** Source account for outgoing payouts — env override, else the checking account. */
export async function getPayoutAccountId(): Promise<string> {
  const env = process.env.MERCURY_PAYOUT_ACCOUNT;
  if (env) return env;
  const accounts = await listMercuryAccounts();
  const checking = accounts.find(a => a.kind === 'checking') || accounts[0];
  if (!checking) throw new Error('No Mercury account available for payouts');
  return checking.id;
}

export interface SendMoneyResult {
  id?: string;
  status?: string; // e.g. 'pendingApproval'
  [k: string]: unknown;
}

/**
 * Create a send-money request to a recipient. Per Mercury's approval rules this
 * lands as `pendingApproval` for a human to approve in the Mercury app — we
 * intentionally never auto-execute a transfer. `amount` is in dollars.
 */
export async function requestSendMoney(
  accountId: string,
  input: { recipientId: string; amount: number; note?: string; idempotencyKey?: string },
): Promise<SendMoneyResult> {
  return mercuryFetch<SendMoneyResult>(`/account/${accountId}/request-send-money`, {
    method: 'POST',
    body: JSON.stringify({
      recipientId: input.recipientId,
      amount: Number(input.amount.toFixed(2)),
      paymentMethod: 'ach',
      note: input.note || undefined,
      idempotencyKey: input.idempotencyKey || undefined,
    }),
  });
}
