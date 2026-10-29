import 'server-only';
import { AppError } from '@/server/errors/app-error';
import type { MeDto } from '@/shared/dto/auth';
import type { UserRole } from '@/shared/enums';

export type { UserRole };

/**
 * C-01: who is acting. Built from the live `users` row on every request (role and canApprove are
 * never cached in the session), so a role change applies on the next request.
 */
export interface Actor {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  canApprove: boolean;
}

/** Persona gates checked by defineRoute({ roles }) before any query (D-25). */
export type Gate = 'APPROVER' | 'FINANCE';

/** "Approver" = can_approve and not FINANCE (the DB also forbids FINANCE + can_approve). */
export const canDecide = (a: Actor): boolean => a.canApprove && a.role !== 'FINANCE';

export const passesGate = (a: Actor, g: Gate): boolean =>
  g === 'APPROVER' ? canDecide(a) : a.role === 'FINANCE';

/** Self-guarding services call this first (D-04): 403 FORBIDDEN before touching the database. */
export function requireRole(a: Actor, g: Gate): void {
  if (!passesGate(a, g)) throw new AppError('FORBIDDEN');
}

/** The UI-facing capability flags (GET /api/v1/auth/me). */
export const toMeDto = (a: Actor): MeDto => ({
  id: a.id,
  email: a.email,
  name: a.name,
  role: a.role,
  canApprove: a.canApprove,
  isFinance: a.role === 'FINANCE',
});
