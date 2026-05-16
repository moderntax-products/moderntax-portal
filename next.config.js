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
};

module.exports = nextConfig;
