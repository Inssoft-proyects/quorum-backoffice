/* eslint-env node */
/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  rootMode: 'upward-optional',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@quorum-backoffice/shared$': '<rootDir>/../../packages/shared/src',
    '^@quorum-backoffice/shared/(.*)$': '<rootDir>/../../packages/shared/src/$1',
  },
  transform: {
    '^.+\\.(ts|tsx)$': ['ts-jest', { useESM: false, isolatedModules: true }],
  },
  collectCoverageFrom: ['src/**/*.{ts,js}', '!src/**/*.d.ts'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'json-summary'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/.next/'],
  verbose: false,
};
