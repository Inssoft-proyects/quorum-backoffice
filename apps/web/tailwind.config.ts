/**
 * Tailwind 4 uses CSS-first configuration via @theme blocks in globals.css.
 * This TS config stays minimal and only points content paths. Tailwind 4
 * reads tokens directly from the @theme block; we keep this file so the
 * shadcn CLI and external tools still see a valid tailwind config.
 */
import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx,js,jsx,mdx}', './components/**/*.{ts,tsx,js,jsx,mdx}'],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
