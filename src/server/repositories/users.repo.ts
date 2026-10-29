import 'server-only';
import type {
  ApprovalStepStatus as DbApprovalStepStatus,
  ApproverResolver as DbApproverResolver,
  ClaimEventType as DbClaimEventType,
  ClaimStatus as DbClaimStatus,
  EventActorRole as DbEventActorRole,
  UserRole as DbUserRole,
} from '@/generated/prisma/client';
import { getDb } from '@/server/db/client';
import type { Tx } from '@/server/db/tx';
import type {
  ApprovalStepStatus,
  ApproverResolver,
  ClaimEventType,
  ClaimStatus,
  EventActorRole,
  UserRole,
} from '@/shared/enums';

// The shared Zod enums (src/shared/enums.ts) must equal the Prisma enums (C-02): drift fails here.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const enumsMatch: [
  Same<DbUserRole, UserRole>,
  Same<DbClaimStatus, ClaimStatus>,
  Same<DbApprovalStepStatus, ApprovalStepStatus>,
  Same<DbApproverResolver, ApproverResolver>,
  Same<DbClaimEventType, ClaimEventType>,
  Same<DbEventActorRole, EventActorRole>,
] = [true, true, true, true, true, true];
void enumsMatch;

export interface LoginCandidate {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  canApprove: boolean;
  isActive: boolean;
  passwordHash: string | null;
}

/**
 * Login lookup by the (already lowercased) email. Inactive users are returned too, so the service
 * can spend the same argon2 time on them as on everyone else before refusing.
 * expense_app has SELECT only on users (C-16).
 */
export function findLoginCandidate(email: string): Promise<LoginCandidate | null> {
  return getDb().user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      canApprove: true,
      isActive: true,
      passwordHash: true,
    },
  });
}

// ---------------------------------------------------------------------------------- routing

/** One users row as the routing engine sees it (02 §4.3). */
export interface RoutingRow {
  id: string;
  managerId: string | null;
  isActive: boolean;
  canApprove: boolean;
  role: UserRole;
  isFallbackApprover: boolean;
}

/**
 * The org slice a chain can reach (02 §4.3): the seeds (claimant + designated users), the fallback
 * approver, and every manager above them, walked by one recursive CTE (cycle-safe via UNION, capped
 * at 25 hops like buildChain). Runs inside the submit transaction: "routed per the org chart as of
 * submit". users is owner-written only (D-35), so the app can't bend its own routing input.
 */
export function loadRoutingRows(tx: Tx, seedIds: readonly string[]): Promise<RoutingRow[]> {
  return tx.$queryRaw<RoutingRow[]>`
    WITH RECURSIVE line AS (
      SELECT u.id, u.manager_id, 0 AS depth
        FROM public.users u
       WHERE u.id = ANY(${[...seedIds]}::uuid[]) OR u.is_fallback_approver
      UNION
      SELECT m.id, m.manager_id, l.depth + 1
        FROM public.users m JOIN line l ON m.id = l.manager_id
       WHERE l.depth < 25
    )
    SELECT u.id, u.manager_id AS "managerId", u.is_active AS "isActive",
           u.can_approve AS "canApprove", u.role::text AS role,
           u.is_fallback_approver AS "isFallbackApprover"
      FROM public.users u
     WHERE u.id IN (SELECT id FROM line)`;
}

/** The claimant block of the C-21 snapshot, exactly as claim_submissions_verify rebuilds it. */
export interface ClaimantIdentity {
  id: string;
  employeeCode: string;
  name: string;
  email: string;
  departmentCode: string;
}

export async function claimantIdentity(tx: Tx, claimantId: string): Promise<ClaimantIdentity> {
  const u = await tx.user.findUniqueOrThrow({
    where: { id: claimantId },
    select: {
      id: true,
      employeeCode: true,
      name: true,
      email: true,
      department: { select: { code: true } },
    },
  });
  return {
    id: u.id,
    employeeCode: u.employeeCode,
    name: u.name,
    email: u.email,
    departmentCode: u.department.code,
  };
}
