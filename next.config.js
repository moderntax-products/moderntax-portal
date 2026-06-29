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
    // @sparticuz/chromium + puppeteer-core must stay external so Vercel ships
    // the Chromium binary (in node_modules) into the lambda instead of webpack
    // trying to bundle it. Used only by the transcript HTML→PDF conversion cron.
    serverComponentsExternalPackages: ['@sendgrid/mail', '@sparticuz/chromium', 'puppeteer-core'],
  },
};

module.exports = nextConfig;
