/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,
  // SOC 2 CC7.1 — don't advertise the framework version to attackers via
  // X-Powered-By, and never ship browser source maps to production (would
  // leak file paths, internal variable names, and the entire build tree).
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  experimental: {
    serverComponentsExternalPackages: ['@sendgrid/mail'],
  },
  // The API reference has a single canonical home on the brand domain
  // (moderntax.io/docs). The portal previously served its own copy at
  // /docs and /docs/api, which drifted out of sync with the deployed API.
  // Redirect both to the canonical doc so there is exactly one source.
  async redirects() {
    return [
      { source: '/docs', destination: 'https://moderntax.io/docs', permanent: true },
      { source: '/docs/:path*', destination: 'https://moderntax.io/docs', permanent: true },
    ];
  },
};

module.exports = nextConfig;
