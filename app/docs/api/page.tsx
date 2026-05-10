/**
 * Public API documentation page — renders docs/API.md as the source of truth.
 *
 * URL: portal.moderntax.io/docs/api
 *
 * The marketing site (moderntax.io/docs) links here so the published
 * reference always matches the deployed code. Single source of truth =
 * no drift between sales pitch + actual API contract.
 *
 * No authentication — this is a public reference. Robots are allowed
 * to crawl the docs (vercel.json sets a global noindex on `/(.*)`,
 * which we override here via metadata).
 */

import fs from 'fs';
import path from 'path';
import { Marked } from 'marked';
import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'ModernTax Partner API Reference',
  description:
    'Complete API reference for ModernTax: transcript intake, 8821-PDF upload, monitoring enrollment, and result polling. SOC 2 Type I, Type II in progress.',
  // Allow indexing — overrides the global X-Robots-Tag: noindex set in
  // vercel.json. Docs benefit from being googleable.
  robots: {
    index: true,
    follow: true,
  },
};

// Render at build time + revalidate hourly. The doc rarely changes,
// so caching is cheap; revalidate keeps deploys-without-content-change
// from showing stale content for too long.
export const revalidate = 3600;

/** Inline a tiny anchor-link slug generator so the renderer can emit
 * stable section ids that match the `#authentication`-style links the
 * marketing site already uses. */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

export default async function ApiDocsPage() {
  const mdPath = path.join(process.cwd(), 'docs', 'API.md');
  const md = fs.readFileSync(mdPath, 'utf8');

  // Custom marked instance: rewrite heading IDs so anchor links work.
  // The default marked output uses raw text as the id which can include
  // punctuation and ambiguous chars; slugify normalizes them.
  const marked = new Marked({
    gfm: true,
    breaks: false,
  });

  // Override the heading renderer to emit ids that match the marketing
  // site's link convention.
  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens);
        const id = slugify(tokens.map(t => ('text' in t ? t.text : '')).join(' '));
        return `<h${depth} id="${id}" class="scroll-mt-24"><a href="#${id}" class="anchor">#</a> ${text}</h${depth}>\n`;
      },
    },
  });

  const html = await marked.parse(md);

  return (
    <div className="min-h-screen bg-white">
      {/* Header — kept slim so the docs feel like a reference, not an app */}
      <header className="border-b border-gray-200 bg-white sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 group">
            <span className="text-mt-green font-extrabold text-xl tracking-tight">
              ModernTax
            </span>
            <span className="text-gray-400 text-sm">/ Docs</span>
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <a
              href="https://moderntax.io/docs"
              className="text-gray-600 hover:text-gray-900"
            >
              Marketing site
            </a>
            <Link
              href="/plans"
              className="text-gray-600 hover:text-gray-900"
            >
              Pricing
            </Link>
            <Link
              href="/login"
              className="px-3 py-1.5 text-white bg-mt-dark rounded-lg hover:bg-mt-navy transition-colors"
            >
              Sign in
            </Link>
          </nav>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-16">
        {/* The `prose` utilities (from @tailwindcss/typography) handle
            most of the markdown styling. We extend a few opinionated
            tweaks so code blocks and tables look closer to a real docs
            site (Stripe, Cloudflare) than a blog. */}
        <article
          className="prose prose-slate max-w-none
            prose-headings:scroll-mt-24
            prose-h1:text-4xl prose-h1:font-extrabold prose-h1:text-mt-dark
            prose-h2:text-2xl prose-h2:font-bold prose-h2:text-mt-dark prose-h2:border-b prose-h2:border-gray-200 prose-h2:pb-2
            prose-h3:text-xl prose-h3:font-semibold prose-h3:text-mt-dark
            prose-a:text-mt-green prose-a:no-underline hover:prose-a:underline
            prose-code:bg-gray-100 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-sm prose-code:font-mono prose-code:text-mt-navy prose-code:before:content-none prose-code:after:content-none
            prose-pre:bg-mt-dark prose-pre:text-gray-100 prose-pre:rounded-lg prose-pre:p-4 prose-pre:overflow-x-auto prose-pre:text-sm
            prose-table:text-sm
            prose-th:bg-gray-50 prose-th:text-mt-dark prose-th:font-semibold
            prose-td:align-top
            prose-blockquote:border-l-mt-green prose-blockquote:bg-gray-50 prose-blockquote:py-1 prose-blockquote:px-4 prose-blockquote:rounded-r prose-blockquote:not-italic
          "
          dangerouslySetInnerHTML={{ __html: html }}
        />

        {/* Soft footer CTA — partners landing here usually want to talk
            to a human about API keys or pricing. */}
        <div className="mt-16 border-t border-gray-200 pt-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-mt-dark">Need an API key or volume pricing?</p>
            <p className="text-sm text-gray-600 mt-1">
              Email{' '}
              <a className="text-mt-green hover:underline" href="mailto:matt@moderntax.io">
                matt@moderntax.io
              </a>{' '}
              — typical onboarding is 1 business day.
            </p>
          </div>
          <Link
            href="/plans"
            className="px-4 py-2 text-sm font-semibold text-white bg-mt-green rounded-lg hover:bg-mt-green/90 transition-colors whitespace-nowrap"
          >
            See pricing →
          </Link>
        </div>
      </main>

      {/* Tiny inline style for the heading-anchor `#` link gutter — only
          shows on hover. Avoids polluting the global stylesheet. */}
      <style>{`
        .prose .anchor {
          color: #cbd5e1;
          text-decoration: none;
          margin-left: -1.5rem;
          padding-right: 0.5rem;
          font-weight: 400;
          opacity: 0;
          transition: opacity 120ms ease;
        }
        .prose h1:hover .anchor,
        .prose h2:hover .anchor,
        .prose h3:hover .anchor,
        .prose h4:hover .anchor {
          opacity: 1;
        }
        .prose .anchor:hover {
          color: #00C48C;
        }
      `}</style>
    </div>
  );
}
