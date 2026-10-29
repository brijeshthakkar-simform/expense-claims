import { z } from 'zod';

/**
 * POST /api/v1/auth/login body (04 §2.4). Strict: unknown keys are refused, never stripped. The
 * email is trimmed and lowercased to match the users_email_lowercase CHECK. No password policy at
 * login: no endpoint sets passwords.
 */
export const LoginInput = z.strictObject({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .pipe(z.email({ error: 'Enter a valid email address' })),
  password: z
    .string()
    .min(1, { error: 'Enter your password' })
    .max(256, { error: 'Password is too long' }),
});
export type LoginInput = z.infer<typeof LoginInput>;
