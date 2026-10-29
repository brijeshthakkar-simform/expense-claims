import { apiFetch, one } from '@/lib/api-client';
import { LoginResult } from '@/shared/dto/auth';
import type { LoginInput } from '@/shared/schemas/auth';

const LoginResponse = one(LoginResult);

/** POST /api/v1/auth/login → 200 `{ data: { user } }` + Set-Cookie; 401 INVALID_CREDENTIALS. */
export const login = (input: LoginInput) =>
  apiFetch('/api/v1/auth/login', { method: 'POST', body: input, schema: LoginResponse });

/** POST /api/v1/auth/logout → 204 and the cookie cleared. */
export const logout = () => apiFetch('/api/v1/auth/logout', { method: 'POST' });
