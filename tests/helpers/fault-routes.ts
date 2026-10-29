// Test-only route modules that fail on purpose (TC-I04, TC-I05). They live under tests/helpers/,
// outside TC-I01's src/app/api glob, and run through the real defineRoute pipeline. No real route
// can surface a DB-backstop SQLSTATE in P1, so these throw the recorded error shapes directly.
import { AppError } from '@/server/errors/app-error';
import { defineRoute } from '@/server/http/define-route';
import { uc012 } from './prisma-shapes';

/** Internals that must never reach a response body. */
export const SECRET_SQL = 'SELECT password_hash FROM users WHERE email = $1';
export const SECRET_HOST = 'db.internal:5432';

/** POST, authenticated: the DB refused at COMMIT with UC012 (a backstop, so our code has a bug). */
export const backstopRoute = {
  POST: defineRoute({
    auth: 'required',
    handler: () => {
      throw uc012();
    },
  }),
};

/** GET, public: an unexpected error whose message and stack carry SQL and a host name. */
export const crashRoute = {
  GET: defineRoute({
    auth: 'public',
    handler: () => {
      throw new TypeError(`query failed: ${SECRET_SQL} on ${SECRET_HOST}`);
    },
  }),
};

/** GET, public: a 503 AppError that (wrongly) carries a message and details; 5xx bodies drop both. */
export const unavailableRoute = {
  GET: defineRoute({
    auth: 'public',
    handler: () => {
      throw new AppError('SERVICE_UNAVAILABLE', `pool exhausted on ${SECRET_HOST}`, {
        sql: SECRET_SQL,
      });
    },
  }),
};
