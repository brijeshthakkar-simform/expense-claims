// Layering rules from docs/design/01-architecture-and-stack.md §7 (D-03), proven by TC-U10.
// Rule options do NOT merge across flat-config blocks: for any one file the last matching
// block's `no-restricted-imports` wins, so every zone lists its complete pattern set.
import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import prettier from 'eslint-config-prettier/flat';

const PRISMA = {
  group: ['@/generated/**', '@/server/db/client', '@prisma/*', 'pg'],
  message: 'Only src/server/repositories and src/server/db may touch Prisma or pg (D-03).',
};
const NEXT = {
  group: ['next', 'next/*'],
  message: 'Services and repositories are framework-agnostic.',
};
const NEXT_HEADERS = {
  group: ['next/headers'],
  message: 'Read cookies from NextRequest; only src/server/auth/rsc.ts may use next/headers.',
};
const REPOS = {
  group: ['@/server/repositories/*'],
  message: 'Route handlers call services, never repositories.',
};
const HTTP = { group: ['@/server/http/*'], message: 'Only route handlers know about HTTP.' };
const SERVICES = { group: ['@/server/services/*'], message: 'Repositories never call services.' };
const SERVER = {
  group: ['@/server/**'],
  message: 'Client and isomorphic code cannot import server modules.',
};
// A regex, not group ['@/server/**', '!@/server/auth/rsc']: groups use gitignore semantics, where
// a file cannot be re-included once its parent directory is excluded, so that negation never fires.
const PAGES = {
  regex: '^@/server(?:$|/(?!auth/rsc$))',
  message: 'Pages and layouts may import only @/server/auth/rsc (D-04).',
};

const restrict = (...patterns) => ({ 'no-restricted-imports': ['error', { patterns }] });

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ['**/*.{ts,tsx,mts}'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "ExpressionStatement[directive='use server']",
          message: 'Server Actions are banned: mutations go through /api/v1 (ADR-0001).',
        },
        {
          selector: "ExpressionStatement[directive='use cache']",
          message: "'use cache' is banned: every response is actor-scoped.",
        },
        {
          selector: "MemberExpression[property.name='$queryRawUnsafe']",
          message: 'Use the tagged $queryRaw template.',
        },
        {
          selector: "MemberExpression[property.name='$executeRawUnsafe']",
          message: 'Use the tagged $executeRaw template.',
        },
      ],
    },
  },
  { files: ['src/app/**/*.{ts,tsx}'], ignores: ['src/app/api/**'], rules: restrict(PAGES, PRISMA) },
  { files: ['src/app/api/**/*.ts'], rules: restrict(PRISMA, REPOS, NEXT_HEADERS) },
  { files: ['src/server/**/*.ts'], rules: restrict(NEXT_HEADERS) },
  { files: ['src/server/services/**/*.ts'], rules: restrict(PRISMA, NEXT, HTTP) },
  { files: ['src/server/repositories/**/*.ts'], rules: restrict(NEXT, HTTP, SERVICES) },
  { files: ['src/server/db/**/*.ts'], rules: restrict(NEXT) },
  { files: ['src/server/auth/rsc.ts'], rules: { 'no-restricted-imports': 'off' } },
  {
    files: ['src/{shared,lib,components,features}/**/*.{ts,tsx}'],
    rules: restrict(SERVER, PRISMA),
  },
  prettier,
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    'src/generated/**',
    'coverage/**',
    '.vitest/**',
    'playwright-report/**',
    'test-results/**',
    // Archived SQL-proof evidence: kept verbatim, outside tsconfig, never linted.
    'docs/reference/**',
  ]),
]);
