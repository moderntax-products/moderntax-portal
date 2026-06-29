/**
 * Server-side HTML → PDF rendering (2026-06-29).
 *
 * IRS transcript HTML is self-contained (inline CSS + a base64 logo), so a
 * headless Chromium renders it faithfully to PDF. Privacy: these documents
 * carry SSNs, so rendering happens IN OUR OWN lambda via @sparticuz/chromium —
 * never a third-party HTML→PDF API.
 *
 * Only imported by the transcript-conversion cron so the heavy Chromium binary
 * stays out of every other lambda. Marked external in next.config.js.
 */

import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

// Common local Chrome locations, so the conversion can be exercised in dev too.
const LOCAL_CHROME_CANDIDATES = [
  process.env.LOCAL_CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
].filter(Boolean) as string[];

async function resolveExecutablePath(): Promise<string> {
  // On Vercel/Lambda use the bundled Chromium; locally fall back to system Chrome.
  if (process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.VERCEL) {
    return await chromium.executablePath();
  }
  const fs = await import('node:fs');
  const found = LOCAL_CHROME_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (!found) throw new Error('No local Chrome found for HTML→PDF (set LOCAL_CHROME_PATH).');
  return found;
}

/**
 * Render a full HTML document string to a US-Letter PDF buffer. Throws on any
 * launch/render failure so the caller can leave the source HTML untouched.
 */
export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const onLambda = !!(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.VERCEL);
  const browser = await puppeteer.launch({
    args: onLambda ? chromium.args : ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1240, height: 1754 },
    executablePath: await resolveExecutablePath(),
    headless: true,
  });
  try {
    const page = await browser.newPage();
    // The HTML is self-contained (no network) → 'load' is sufficient and fast.
    await page.setContent(html, { waitUntil: 'load', timeout: 20_000 });
    const pdf = await page.pdf({
      format: 'letter',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '0.4in', bottom: '0.4in', left: '0.3in', right: '0.3in' },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close().catch(() => {});
  }
}
