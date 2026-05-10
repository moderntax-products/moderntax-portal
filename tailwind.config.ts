import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        'mt-green': '#00C48C',
        'mt-dark': '#0A1929',
        'mt-navy': '#102A43',
      },
    },
  },
  plugins: [
    // Enables `prose` utility classes for nicely-formatted markdown
    // output (used by app/docs/api for the partner API reference).
    require('@tailwindcss/typography'),
  ],
};
export default config;
