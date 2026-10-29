import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const emptyModule = fileURLToPath(new URL('./tests/helpers/empty-module.ts', import.meta.url));

export default defineConfig({
  resolve: {
    tsconfigPaths: true, // Vite 8 resolves `@/*` natively; it warns when vite-tsconfig-paths is used
    alias: { 'server-only': emptyModule }, // server-only throws outside react-server (01 §4 #18)
  },
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['tests/unit/**/*.test.ts'], environment: 'node' },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.int.test.ts'],
          environment: 'node',
          globalSetup: ['tests/helpers/global-setup.ts'],
          setupFiles: ['tests/helpers/integration-setup.ts'], // per-test hooks (07 §3.2)
          fileParallelism: false, // one database, and deferred checks need real COMMITs
          sequence: { hooks: 'stack' }, // after-hooks run in reverse: closeTestClients first
          testTimeout: 30_000,
          hookTimeout: 180_000,
        },
      },
      {
        // Presentational components with props in and callbacks out (05 §15.2): jsdom, React's
        // automatic JSX runtime, and a browser far from IST so business-day dates must come from
        // Asia/Kolkata, never from the machine's zone.
        extends: true,
        plugins: [react()],
        test: {
          name: 'component',
          include: ['tests/component/**/*.test.tsx'],
          environment: 'jsdom',
          env: { TZ: 'America/Los_Angeles' },
          setupFiles: ['tests/helpers/component-setup.ts'],
        },
      },
    ],
  },
});
