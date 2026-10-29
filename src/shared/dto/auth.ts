import { z } from 'zod';
import { UserRole } from '@/shared/enums';

/**
 * GET /api/v1/auth/me and the login response (C-10). The UI derives navigation from these flags
 * only; the server re-decides every action. `isFinance` = role === 'FINANCE'.
 */
export const MeDto = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string(),
  role: UserRole,
  canApprove: z.boolean(),
  isFinance: z.boolean(),
});
export type MeDto = z.infer<typeof MeDto>;

/** 200 body of POST /api/v1/auth/login, inside the `{ data }` envelope. */
export const LoginResult = z.object({ user: MeDto });
export type LoginResult = z.infer<typeof LoginResult>;
