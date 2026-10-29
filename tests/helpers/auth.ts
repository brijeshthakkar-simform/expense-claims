// Auth helpers for integration tests (07 §5.1). Deliberately NOT exported from src: production code
// has no "log in as anyone" path. Only TC-I02 logs in through the real route with a password.
import { createHash, randomBytes } from 'node:crypto';
import type { Actor } from '@/server/auth/actor';
import { sessionCookieName } from '@/server/auth/cookie';
import { appSql } from './db';

/** The C-15 cast (who to use for what: 07 §5.2). */
export const PERSONAS = {
  asha: 'asha.rao',
  ravi: 'ravi.menon',
  meera: 'meera.iyer',
  vikram: 'vikram.shah',
  deepa: 'deepa.menon',
  neha: 'neha.kapoor',
  arjun: 'arjun.das',
  farah: 'farah.khan',
  admin: 'admin',
} as const;
export type Persona = keyof typeof PERSONAS;

export const emailOf = (p: Persona): string => `${PERSONAS[p]}@acme.test`;

/** The live users row as an Actor (read as expense_app, like authenticate()). */
export async function asPersona(p: Persona | { email: string }): Promise<Actor> {
  const email = typeof p === 'string' ? emailOf(p) : p.email;
  const [u] = await appSql<Actor>`
    SELECT id, email, name, role, can_approve AS "canApprove" FROM users WHERE email = ${email}`;
  if (!u) throw new Error(`no user ${email}: is the cast seeded?`);
  return u;
}

export const sha256Hex = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/**
 * Mints a session the way login does (sha256 of a random 32-byte token, inserted as expense_app)
 * and returns the Cookie header value. Pass past expiries for the expired-session cases.
 */
export async function createSession(
  userId: string,
  o: { idleExpiresAt?: Date; absoluteExpiresAt?: Date; lastSeenAt?: Date } = {},
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await appSql`
    INSERT INTO sessions (user_id, token_hash, idle_expires_at, absolute_expires_at, last_seen_at)
    VALUES (${userId}, ${sha256Hex(token)},
            ${o.idleExpiresAt ?? new Date(Date.now() + 3_600_000)},
            ${o.absoluteExpiresAt ?? new Date(Date.now() + 43_200_000)},
            ${o.lastSeenAt ?? new Date()})`;
  return `${sessionCookieName('http://localhost:3000')}=${token}`; // ec_session on http
}

/** The token inside a `name=value` cookie string. */
export const tokenOf = (cookie: string): string => cookie.slice(cookie.indexOf('=') + 1);
