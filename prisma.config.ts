import { loadEnvConfig } from '@next/env';
import { defineConfig } from 'prisma/config';

// Prisma 7 does not load .env itself. Same precedence as Next; real env (compose, CI) always wins.
loadEnvConfig(process.cwd());

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx --conditions=react-server prisma/seed.ts',
  },
  datasource: {
    // The CLI runs as the OWNER. process.env (not env()) so `prisma generate` works in a Docker
    // build with no URL at all.
    url: process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL ?? '',
    // Optional: `migrate dev` creates its own shadow DB (the owner has CREATEDB). An empty value,
    // e.g. from compose's `${SHADOW_DATABASE_URL:-}`, is a P1013 error, so treat it as unset.
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL || undefined,
  },
});
