# syntax=docker/dockerfile:1
# Targets: base → deps → build → runner | tools (01 §10.1).
#   runner: serves traffic; no CLI, devDependencies, source or .env.
#   tools:  one-shot jobs (migrate | seed | ensure-bucket | release); never serves traffic.
#
# Digest-pinned (multi-arch index, resolved 2026-10-14); bump tag + digest together.
ARG NODE_IMAGE=node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66

# ── base ─────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# corepack resolves pnpm from package.json "packageManager" (pnpm@10.34.6)
RUN corepack enable
WORKDIR /app

# ── deps: all dependencies (incl. dev) with Linux-native binaries ────────────
FROM base AS deps
# openssl + CA certs: Prisma schema-engine platform detection and TLS to managed Postgres
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# pnpm-workspace.yaml carries onlyBuiltDependencies, so @prisma/engines fetches the schema-engine here
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile

# ── build: Next standalone (needs ZERO env; .env* never enters the context) ──
FROM deps AS build
COPY . .
# public/ may be missing on a clean clone (git does not track empty dirs); the runner COPYs it.
RUN mkdir -p public \
 && pnpm db:generate \
 && pnpm build \
 && test -f .next/standalone/server.js            # fail fast if standalone output regresses

# ── tools: one-shot jobs (migrate, seed, ensure-bucket). Never serves traffic. ─
FROM deps AS tools
COPY . .
RUN pnpm db:generate && chmod +x docker/tools/entrypoint.sh
# CHECKPOINT_DISABLE: no Prisma CLI update/telemetry call from a release job
ENV NODE_ENV=production PATH=/app/node_modules/.bin:$PATH CHECKPOINT_DISABLE=1
USER node
ENTRYPOINT ["/app/docker/tools/entrypoint.sh"]
CMD ["release"]

# ── runner: minimal production image ─────────────────────────────────────────
FROM ${NODE_IMAGE} AS runner
ARG APP_VERSION=dev
# HOSTNAME: Docker sets it to the container id, and server.js would bind only to that (01 §4 trap 8)
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 APP_VERSION=${APP_VERSION}
WORKDIR /app
RUN mkdir .next && chown node:node .next
# Standalone output omits public/ and .next/static; server.js serves them once copied next to it.
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
# uid 1000. Next standalone handles SIGTERM itself, so NEXT_MANUAL_SIG_HANDLE stays unset.
USER node
EXPOSE 3000
# The slim image has no curl: probe readiness (DB + integrity triggers) with Node's global fetch.
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]
