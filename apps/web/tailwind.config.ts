/**
 * WU0 placeholder for Tailwind 4 theme.
 *
 * Tailwind 4 prefers CSS-first config via `@theme` blocks in globals.css,
 * so this file is intentionally minimal. WU1 will replace it with the
 * full InecConecta token palette (see odd/tasks/quorum-backoffice-mvp.md §6).
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
