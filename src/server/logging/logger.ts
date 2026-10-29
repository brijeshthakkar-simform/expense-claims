import 'server-only';
import pino from 'pino';
import { requestContext } from '@/server/http/request-context';

const LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
type Level = (typeof LEVELS)[number];

// Reads the raw variables (already validated by env() at boot) so importing this module never
// throws during `next build`; an unknown level falls back to info instead of crashing pino.
const rawLevel = process.env.LOG_LEVEL;
const level: Level = LEVELS.includes(rawLevel as Level) ? (rawLevel as Level) : 'info';

/**
 * D-40: JSON to stdout, no transports (worker threads break under Next bundling; pretty output is
 * `pnpm dev:pretty`). The mixin stamps requestId/userId/route from the request's AsyncLocalStorage
 * context on every line, so nothing passes loggers around. Redaction is the safety net; the rule is
 * never to hand bodies, cookies, tokens or passwords to the logger at all (06 §2.5).
 */
export const logger = pino({
  level,
  base: {
    service: 'expense-claims',
    env: process.env.APP_ENV ?? 'local',
    version: process.env.APP_VERSION ?? 'dev',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  mixin() {
    const rc = requestContext.getStore();
    return rc ? { requestId: rc.requestId, userId: rc.userId, route: rc.route } : {};
  },
  redact: {
    paths: [
      'cookie',
      '*.cookie',
      '*.*.cookie',
      'authorization',
      '*.authorization',
      '*.*.authorization',
      '"set-cookie"',
      '*["set-cookie"]',
      '*.*["set-cookie"]',
      'password',
      '*.password',
      'token',
      '*.token',
      '*.passwordHash',
    ],
    censor: '[REDACTED]',
  },
  serializers: { err: pino.stdSerializers.err },
});

/** C-19, a closed list: a typo in an event name fails typecheck. */
export type LogEventName =
  | 'app.boot'
  | 'app.shutdown'
  | 'http.request'
  | 'auth.login.succeeded'
  | 'auth.login.failed'
  | 'auth.logout'
  | 'authz.denied'
  | 'claim.created'
  | 'claim.updated'
  | 'claim.deleted'
  | 'claim.submitted'
  | 'claim.resubmitted'
  | 'claim.step_approved'
  | 'claim.approved'
  | 'claim.rejected'
  | 'claim.recalled'
  | 'receipt.uploaded'
  | 'receipt.deleted'
  | 'receipt.object_orphaned'
  | 'export.started'
  | 'export.completed'
  | 'export.failed'
  | 'db.backstop';

export const logEvent = (
  event: LogEventName,
  fields: Record<string, unknown> = {},
  lvl: pino.Level = 'info',
) => logger[lvl]({ event, ...fields });

/**
 * The logger for a service whose work may continue after the route handler returns (the export
 * stream). Inside a request it is `logger` itself, because the mixin already stamps the request's
 * ids (a child would print each key twice); outside one (tests, scripts) a child carries them.
 */
export function loggerFor(ctx: { requestId: string; userId?: string }): pino.Logger {
  return requestContext.getStore()
    ? logger
    : logger.child({ requestId: ctx.requestId, userId: ctx.userId });
}
