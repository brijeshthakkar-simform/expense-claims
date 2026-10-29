import 'server-only';
import { getDb } from '@/server/db/client';
import type { UserRole } from '@/shared/enums';

// Opaque DB sessions (D-05, 04 §2.2). Only sha256(token) hex is ever stored or queried.

export interface NewSession {
  userId: string;
  tokenHash: string;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  userAgent: string | null;
}

export interface LiveSession {
  id: string;
  lastSeenAt: Date;
  absoluteExpiresAt: Date;
  user: { id: string; email: string; name: string; role: UserRole; canApprove: boolean };
}

export async function insertSession(s: NewSession): Promise<void> {
  await getDb().session.create({ data: s, select: { id: true } });
}

/**
 * The "real user" check (§6): the hash matches a session whose idle and absolute expiry are both in
 * the future, and the user is active. The user columns are read live, never cached in the session.
 */
export function findLiveSession(tokenHash: string, now: Date): Promise<LiveSession | null> {
  return getDb().session.findFirst({
    where: {
      tokenHash,
      idleExpiresAt: { gt: now },
      absoluteExpiresAt: { gt: now },
      user: { isActive: true },
    },
    select: {
      id: true,
      lastSeenAt: true,
      absoluteExpiresAt: true,
      user: { select: { id: true, email: true, name: true, role: true, canApprove: true } },
    },
  });
}

/** Sliding idle expiry. updateMany: a session deleted meanwhile (logout) is simply not found. */
export async function touchSession(id: string, now: Date, idleExpiresAt: Date): Promise<void> {
  await getDb().session.updateMany({ where: { id }, data: { lastSeenAt: now, idleExpiresAt } });
}

export async function deleteSessionByTokenHash(tokenHash: string): Promise<void> {
  await getDb().session.deleteMany({ where: { tokenHash } });
}

/** Opportunistic cleanup on login (no cron): sessions that expired before `before`. */
export async function deleteSessionsExpiredBefore(before: Date): Promise<number> {
  const { count } = await getDb().session.deleteMany({
    where: { OR: [{ idleExpiresAt: { lt: before } }, { absoluteExpiresAt: { lt: before } }] },
  });
  return count;
}
