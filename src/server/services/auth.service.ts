import 'server-only';
import { toMeDto } from '@/server/auth/actor';
import { hashPassword, verifyPassword } from '@/server/auth/password';
import { createSession, destroySession } from '@/server/auth/session';
import { AppError } from '@/server/errors/app-error';
import { logEvent, logger } from '@/server/logging/logger';
import { findLoginCandidate } from '@/server/repositories/users.repo';
import { deleteSessionsExpiredBefore } from '@/server/repositories/sessions.repo';
import type { ServiceCtx } from '@/server/services/context';
import type { MeDto } from '@/shared/dto/auth';
import type { LoginInput } from '@/shared/schemas/auth';

// 04 §2.4. Services never import next/*: login returns the token and the route writes the cookie.

const DAY_MS = 86_400_000;

// A real argon2id hash of a random secret, computed once per process. Unknown emails and users
// without a password verify against it, so every failure path spends the same argon2 time and the
// response timing doesn't reveal which accounts exist.
let dummyHash: Promise<string> | undefined;
const getDummyHash = () =>
  (dummyHash ??= hashPassword(crypto.randomUUID()).catch((err: unknown) => {
    dummyHash = undefined;
    throw err;
  }));

type FailureReason = 'unknown_email' | 'inactive_user' | 'no_password' | 'wrong_password';

export interface LoginResult {
  token: string;
  absoluteExpiresAt: Date;
  user: MeDto;
}

/**
 * Password login (public route). Any session presented with the request is deleted first
 * (fixation-safe: a new token on every login). Unknown email, inactive user, no password hash and a
 * wrong password all throw the same 401 INVALID_CREDENTIALS; only the log knows which, and it never
 * records the email or the password.
 */
export async function login(
  input: LoginInput,
  meta: { userAgent: string | null; presentedToken?: string },
): Promise<LoginResult> {
  await destroySession(meta.presentedToken);

  const candidate = await findLoginCandidate(input.email);
  const passwordOk = await verifyPassword(
    candidate?.passwordHash ?? (await getDummyHash()),
    input.password,
  );
  const reason: FailureReason | null = !candidate
    ? 'unknown_email'
    : !candidate.passwordHash
      ? 'no_password'
      : !candidate.isActive
        ? 'inactive_user'
        : !passwordOk
          ? 'wrong_password'
          : null;
  if (reason || !candidate) {
    logEvent('auth.login.failed', { reason }, 'warn');
    throw new AppError('INVALID_CREDENTIALS');
  }

  const { token, absoluteExpiresAt } = await createSession(candidate.id, meta.userAgent);
  // Opportunistic cleanup; a failure here must not fail a good login.
  await deleteSessionsExpiredBefore(new Date(Date.now() - DAY_MS)).catch((err: unknown) =>
    logger.warn({ err }, 'expired-session cleanup failed'),
  );
  const user = toMeDto(candidate);
  logEvent('auth.login.succeeded', { userId: user.id });
  return { token, absoluteExpiresAt, user };
}

/** Deletes the caller's session row; the route clears the cookie and answers 204. */
export async function logout(ctx: ServiceCtx, token: string | undefined): Promise<void> {
  await destroySession(token);
  logEvent('auth.logout', { userId: ctx.actor.id });
}

/** GET /api/v1/auth/me: the live actor's capability flags. */
export function me(ctx: ServiceCtx): MeDto {
  return toMeDto(ctx.actor);
}
