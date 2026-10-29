import 'server-only';
import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

// 04 §2.3: argon2id from Node's built-in crypto (Node ≥ 24.7, no native addon), OWASP minimum
// parameters, stored as a standard PHC string. Parameters live inside each hash, so an owner script
// can raise them later; there is no rehash-on-login (expense_app can't write users).
const argon2Async = promisify(argon2);
const PARAMS = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 } as const;
const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;
const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '');

/** Used by the owner-run seed (and the login timing equaliser), never by a request path. */
export async function hashPassword(password: string): Promise<string> {
  const nonce = randomBytes(16);
  const tag = await argon2Async('argon2id', {
    message: password.normalize('NFKC'),
    nonce,
    ...PARAMS,
  });
  return `$argon2id$v=19$m=${PARAMS.memory},t=${PARAMS.passes},p=${PARAMS.parallelism}$${b64(nonce)}$${b64(tag)}`;
}

/** Constant-time compare of the recomputed tag. A malformed stored hash verifies as false. */
export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const m = PHC.exec(stored);
  if (!m) return false;
  const [mem, t, p, salt, hash] = m.slice(1) as [string, string, string, string, string];
  const expected = Buffer.from(hash, 'base64');
  const actual = await argon2Async('argon2id', {
    message: password.normalize('NFKC'),
    nonce: Buffer.from(salt, 'base64'),
    memory: Number(mem),
    passes: Number(t),
    parallelism: Number(p),
    tagLength: expected.length,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
