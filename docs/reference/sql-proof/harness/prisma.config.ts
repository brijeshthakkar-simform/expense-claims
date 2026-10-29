// Scratch prisma.config.ts for the SQL proof (Prisma 7.10). The real app's config is:
//   schema 'prisma/schema.prisma', migrations.path 'prisma/migrations',
//   datasource.url = MIGRATE_DATABASE_URL ?? DATABASE_URL, shadowDatabaseUrl = SHADOW_DATABASE_URL (optional)
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: process.env.PRISMA_SCHEMA ?? 'out/schema.prisma',
  migrations: { path: process.env.PRISMA_MIGRATIONS ?? 'out/migrations-full' },
  datasource: {
    url: process.env.MIGRATE_DATABASE_URL ?? 'postgresql://nobody:nothing@127.0.0.1:1/none',
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
