/**
 * Clients billed by the dedicated 1-click monthly-invoice cron
 * (app/api/cron/monthly-client-invoices) rather than the general auto-invoice
 * draft run. These accounts get their invoice generated at 7pm PT on the last
 * calendar day of the month, and Matt sends it with one click (see-it-first).
 *
 * Single source of truth so auto-invoice can EXCLUDE them — otherwise both
 * crons would race to create the same invoice_number for the same period.
 */
export const MONTHLY_1CLICK_CLIENTS: Array<{ id: string; name: string }> = [
  { id: '60f80d60-03ad-42d7-95da-c0f1cd311523', name: 'Centerstone' },
  { id: '3256293c-6c98-42bc-a828-2b73a603048e', name: 'Cal Statewide' },
];

export const MONTHLY_1CLICK_CLIENT_IDS = MONTHLY_1CLICK_CLIENTS.map((c) => c.id);
