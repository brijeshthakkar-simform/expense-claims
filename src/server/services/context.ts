import 'server-only';
import type { Actor } from '@/server/auth/actor';

// C-26. Services, defineRoute, the seed and the test factories import these types; services never
// import @/server/http/*.

/** Backdated "now" for the owner-run seed only (02 §9). Route handlers never pass one. */
export interface SeedClock {
  now(): Date;
}

/** The first argument of every service function: `(ctx: ServiceCtx, ...ids, input?)`. */
export interface ServiceCtx {
  actor: Actor;
  requestId: string;
  clock?: SeedClock;
}
