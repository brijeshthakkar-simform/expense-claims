import 'server-only';
import { cookies } from 'next/headers';
import { cache } from 'react';
import { toMeDto, type Actor } from '@/server/auth/actor';
import { sessionCookieName } from '@/server/auth/cookie';
import { actorForToken } from '@/server/auth/session';
import { env } from '@/server/env';
import type { MeDto } from '@/shared/dto/auth';

// The ONLY server module pages and layouts may import (D-04, ESLint pages zone), and the only
// next/headers user in src/server. Server Components get identity here and nothing else: every
// data read goes through /api/v1.

export type { Actor, MeDto };

/**
 * The signed-in actor for this render, or null. Same verifier as defineRoute (`actorForToken`),
 * memoised per request by React `cache`, so a layout and its page share one lookup.
 */
export const getActor = cache(async (): Promise<Actor | null> => {
  const token = (await cookies()).get(sessionCookieName(env().APP_BASE_URL))?.value;
  return actorForToken(token);
});

/** The actor as the UI sees it (`MeDto`: adds `isFinance`), for the shell's navigation. */
export const getMe = cache(async (): Promise<MeDto | null> => {
  const actor = await getActor();
  return actor && toMeDto(actor);
});

/** Whether the login page may list the demo accounts (never the password). False outside local. */
export function isDemoMode(): boolean {
  return env().DEMO_MODE;
}
