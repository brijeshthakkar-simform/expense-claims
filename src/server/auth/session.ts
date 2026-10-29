import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import type { NextRequest } from 'next/server';
import type { Actor } from '@/server/auth/actor';
import { readSessionToken } from '@/server/auth/cookie';
import { env } from '@/server/env';
import { AppError } from '@/server/errors/app-error';
import {
  deleteSessionByTokenHash,
  findLiveSession,
  insertSession,
  touchSession,
} from '@/server/repositories/sessions.repo';

// 04 §2.2: opaque 256-bit token in the cookie, sha256(token) hex in the DB, so a DB read leak yields
// no usable cookie. Idle expiry slides (written at most every 5 minutes); absolute expiry is fixed.

/** 32 random bytes as base64url = 43 characters. Anything else never reaches Postgres. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const TOUCH_EVERY_MS = 5 * 60_000;

export const sha256Hex = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export const isWellFormedToken = (token: string | undefined): token is string =>
  token !== undefined && TOKEN_RE.test(token);

/** A fresh session for `userId`. Returns the token (cookie value) once; only its hash is stored. */
export async function createSession(
  userId: string,
  userAgent: string | null,
): Promise<{ token: string; absoluteExpiresAt: Date }> {
  const e = env();
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const absoluteExpiresAt = new Date(now + e.SESSION_ABSOLUTE_TIMEOUT_HOURS * 3_600_000);
  const idleExpiresAt = new Date(
    Math.min(now + e.SESSION_IDLE_TIMEOUT_MINUTES * 60_000, absoluteExpiresAt.getTime()),
  );
  await insertSession({
    userId,
    tokenHash: sha256Hex(token),
    idleExpiresAt,
    absoluteExpiresAt,
    userAgent: userAgent?.slice(0, 512) ?? null,
  });
  return { token, absoluteExpiresAt };
}

/**
 * The single session verifier, shared by defineRoute (via authenticate) and getActor (rsc.ts).
 * Null unless the token is well formed, its session is within both expiries and the user is
 * active. Role and canApprove come from the live users row.
 */
export async function actorForToken(token: string | undefined): Promise<Actor | null> {
  if (!isWellFormedToken(token)) return null;
  const now = new Date();
  const s = await findLiveSession(sha256Hex(token), now);
  if (!s) return null;
  if (now.getTime() - s.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
    const idle = now.getTime() + env().SESSION_IDLE_TIMEOUT_MINUTES * 60_000;
    await touchSession(s.id, now, new Date(Math.min(idle, s.absoluteExpiresAt.getTime())));
  }
  const { id, email, name, role, canApprove } = s.user;
  return { id, email, name, role, canApprove };
}

/**
 * Route-handler authentication: reads the cookie from NextRequest only (never next/headers), so a
 * handler stays a plain function that tests call in-process. 401 UNAUTHENTICATED otherwise.
 */
export async function authenticate(req: NextRequest): Promise<Actor> {
  const actor = await actorForToken(readSessionToken(req.cookies, env().APP_BASE_URL));
  if (!actor) throw new AppError('UNAUTHENTICATED');
  return actor;
}

/** Deletes the session a token belongs to (logout, or a session presented to login). */
export async function destroySession(token: string | undefined): Promise<void> {
  if (isWellFormedToken(token)) await deleteSessionByTokenHash(sha256Hex(token));
}
