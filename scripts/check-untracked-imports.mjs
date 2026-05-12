#!/usr/bin/env node
/**
 * check-untracked-imports.mjs
 *
 * Pre-push guard against the most common deploy-breaking trap in this
 * repo: a tracked file `import`ing a `@/lib/...` or `@/components/...`
 * module whose source lives on local disk but was never `git add`ed.
 * Local `next build` resolves the module from the working copy and
 * passes; Vercel's clone-from-main can't find it and the deploy ERRORs.
 *
 * Caught instances this week:
 *   - lib/phone-pool, lib/business-day, lib/fire-call, lib/cash-flow-pdf,
 *     lib/extract-8821-pdf, lib/order-gate, lib/calendar-invite,
 *     components/TierUpgradeButton, ProcessorUpgradeCTAs, UpgradeYourTeamPanel
 *
 * What this script does:
 *   1. Lists every tracked .ts / .tsx file via `git ls-files`.
 *   2. Greps each for imports matching `@/<path>` (the Next.js path alias).
 *   3. Resolves each import to one of: <path>.ts | <path>.tsx |
 *      <path>/index.ts | <path>/index.tsx
 *   4. If the resolved file isn't ALSO in the tracked set, reports an error.
 *
 * Exit 0 = clean. Exit 1 = problems found (printed with file:line context).
 *
 * Usage:
 *   node scripts/check-untracked-imports.mjs       # check + report
 *   npm run check:imports                          # same, via package.json
 *   bypass via: git push --no-verify               # NOT recommended
 *
 * Performance: ~700 tracked TS files, ~600ms wall-time on a 2024 MacBook.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';

// ANSI colors (skip them if stdout isn't a TTY — keeps CI logs clean).
const isTty = process.stdout.isTTY;
const c = {
  red:    s => isTty ? `\x1b[31m${s}\x1b[0m`   : s,
  green:  s => isTty ? `\x1b[32m${s}\x1b[0m`   : s,
  yellow: s => isTty ? `\x1b[33m${s}\x1b[0m`   : s,
  dim:    s => isTty ? `\x1b[2m${s}\x1b[22m`  : s,
  bold:   s => isTty ? `\x1b[1m${s}\x1b[22m`  : s,
};

// `git rev-parse --show-toplevel` so the script works regardless of CWD
// (including from inside a subdir like /scripts).
const root = execSync('git rev-parse --show-toplevel', { stdio: ['ignore', 'pipe', 'ignore'] })
  .toString().trim();

// All tracked .ts/.tsx files. We check every file (not just staged) so
// that pre-push catches issues introduced by intermediate commits.
const trackedFiles = execSync('git ls-files "*.ts" "*.tsx"', { cwd: root })
  .toString().split('\n').filter(Boolean);

// Set of all tracked paths — used to verify each resolved import target
// is actually in git.
const trackedSet = new Set(trackedFiles);

// Capture both `import x from '@/foo'` and `import('@/foo')` (dynamic).
// Quotes can be single or double. Path alias root is `@/`.
const importRegex = /(?:from|import)\s*\(?\s*['"](@\/[^'"]+)['"]/g;

const issues = [];   // { file, importPath, candidates }
let scanned = 0;

for (const file of trackedFiles) {
  let content;
  try {
    content = readFileSync(pathResolve(root, file), 'utf8');
  } catch (err) {
    // File listed by git but missing on disk (rare — typically a
    // mid-merge state). Skip with a warning; don't fail.
    console.warn(c.yellow(`  warn: could not read ${file} (${err.code || err.message})`));
    continue;
  }
  scanned += 1;

  // Reset lastIndex because we're reusing the regex object (`g` flag).
  importRegex.lastIndex = 0;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const importPath = match[1];
    // Strip the leading "@/" — the project uses tsconfig path "@/*" → "./*"
    const relativePath = importPath.slice(2);

    // Skip when the import points at a directory of pages/route segments
    // (e.g., `@/app/foo/bar`) — we only validate code modules, not
    // virtual import paths. Filter by extension at resolve time instead.
    const candidates = [
      `${relativePath}.ts`,
      `${relativePath}.tsx`,
      `${relativePath}/index.ts`,
      `${relativePath}/index.tsx`,
      // CSS / JSON imports are valid too but Next aliases them through
      // the same `@/` path. Include common extensions defensively.
      `${relativePath}.css`,
      `${relativePath}.json`,
    ];

    const resolved = candidates.find(c => trackedSet.has(c));
    if (!resolved) {
      issues.push({ file, importPath, candidates });
    }
  }
}

if (issues.length === 0) {
  console.log(c.green(`✓ check-untracked-imports: clean (${scanned} files scanned)`));
  process.exit(0);
}

// Group by missing module so multiple files importing the same problem
// module collapse to one error block.
const byModule = new Map(); // importPath → [files]
for (const { file, importPath } of issues) {
  if (!byModule.has(importPath)) byModule.set(importPath, []);
  byModule.get(importPath).push(file);
}

console.error('');
console.error(c.red(c.bold('❌ check-untracked-imports: found imports of files NOT tracked in git')));
console.error(c.dim(`   (Vercel will fail to build with "Module not found" for each of these)`));
console.error('');

for (const [importPath, files] of byModule.entries()) {
  // Show a candidate path on disk that DOES exist (untracked file) so the
  // user knows exactly what to `git add`.
  const relativePath = importPath.slice(2);
  const onDiskCandidates = [
    `${relativePath}.ts`,
    `${relativePath}.tsx`,
    `${relativePath}/index.ts`,
    `${relativePath}/index.tsx`,
  ];
  let onDiskHit = null;
  for (const c2 of onDiskCandidates) {
    try {
      readFileSync(pathResolve(root, c2));
      onDiskHit = c2;
      break;
    } catch { /* not on disk */ }
  }

  console.error(c.bold(`  ${importPath}`));
  if (onDiskHit) {
    console.error(`    ${c.green('found on disk →')} ${c.bold(onDiskHit)}  ${c.dim('(untracked — needs git add)')}`);
  } else {
    console.error(`    ${c.yellow('not found on disk either')} — typo or deleted file?`);
  }
  console.error(`    imported by:`);
  for (const f of files) console.error(`      - ${f}`);
  console.error('');
}

console.error(c.bold('Fix:'));
const allUntrackedHits = new Set();
for (const importPath of byModule.keys()) {
  const relativePath = importPath.slice(2);
  for (const c2 of [`${relativePath}.ts`, `${relativePath}.tsx`, `${relativePath}/index.ts`, `${relativePath}/index.tsx`]) {
    try {
      readFileSync(pathResolve(root, c2));
      allUntrackedHits.add(c2);
      break;
    } catch { /* skip */ }
  }
}
if (allUntrackedHits.size > 0) {
  console.error(`  git add ${Array.from(allUntrackedHits).join(' \\\n          ')}`);
} else {
  console.error('  (no candidate files found on disk — review the imports listed above)');
}
console.error('');
console.error(c.dim(`Bypass with: git push --no-verify   ${c.bold('(NOT recommended — Vercel will fail)')}`));
console.error('');

process.exit(1);
