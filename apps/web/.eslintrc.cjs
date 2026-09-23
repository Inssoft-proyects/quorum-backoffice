/**
 * ESLint legacy config for the Next.js web app.
 *
 * Why `.eslintrc.cjs` instead of `eslint.config.js`:
 * The project pins `eslint@^8.57.0` (ESLint 8 LTS), which fully supports
 * legacy `.eslintrc.*` configs and only partially supports flat config
 * (flat config became the default in ESLint 9). Upgrading to ESLint 9
 * would force a `package-lock.json` regeneration outside the scope of
 * this WU, and `eslint-config-next@15.0.4` ships pre-flat-config presets
 * that are awkward to consume from a flat config without the
 * `@eslint/eslintrc` compatibility shim. Sticking with ESLint 8 + legacy
 * format keeps the change scoped and works out of the box with the
 * already-installed `eslint-config-next`.
 *
 * Future migration: when the repo upgrades ESLint to 9.x globally, port
 * this file to `eslint.config.js` using `@eslint/eslintrc`'s FlatCompat.
 */
module.exports = {
  root: true,
  extends: ['next/core-web-vitals', 'next/typescript', 'prettier'],
  ignorePatterns: [
    '.next/**',
    'node_modules/**',
    'dist/**',
    'coverage/**',
    'next-env.d.ts',
    'out/**',
    'build/**',
  ],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
  rules: {
    // Allow non-null assertions in test files and narrow server-only contexts.
    '@typescript-eslint/no-non-null-assertion': 'off',
  },
  overrides: [
    {
      files: ['e2e/**/*.{ts,tsx,js,jsx}', 'test/**/*.{ts,tsx,js,jsx}'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
  ],
};