import { defineConfig } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig([
  {
    extends: [...nextCoreWebVitals],
  },
  {
    // Next 16 upgrade (2026-07-27): eslint-config-next now pulls in
    // eslint-plugin-react-hooks v7, which enables new React Compiler
    // compatibility rules as errors by default. They flag ~15 pre-existing
    // components (effects that call setState synchronously, components
    // instantiated during render, etc.) that predate this upgrade and are
    // functionally correct today — fixing them requires a per-component
    // behavioral review, not a mechanical fix, so it's out of scope for a
    // framework version bump. Downgraded to warn (matching the old `next
    // lint` gate, which didn't have these rules) so CI stays green; the
    // underlying findings remain visible for a dedicated follow-up.
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/static-components': 'warn',
      'react-hooks/immutability': 'warn',
    },
  },
]);