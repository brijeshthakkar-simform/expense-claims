/**
 * Boot checks (01 §9.2, D-34, D-39). A misconfigured server must not take traffic, and a throw
 * from register() may not stop it, so every failure ends in an explicit process.exit(1): the
 * container exits non-zero and `docker compose ps` shows it.
 */
export async function register(): Promise<void> {
  // A positive NEXT_RUNTIME check (not an early return) lets the edge compile drop this branch,
  // so Node-only APIs never reach the Edge runtime analysis.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { env } = await import('@/server/env');
      const e = env(); // 1. config is valid
      const { assertNoForbiddenEnv, assertRuntimeRole } =
        await import('@/server/auth/runtime-role');
      assertNoForbiddenEnv(); // 2. production: no owner/superuser material in this process
      await assertRuntimeRole(); // 3. the connected role is least-privilege
      const { assertPolicyLoadsWellFormed } = await import('@/server/routing/policy');
      await assertPolicyLoadsWellFormed(); // 4. the approval policy is well formed (D-19)
      const { logger } = await import('@/server/logging/logger');
      // `version` is already a base field of every line (06 §2.3: no duplicate standard keys).
      logger.info({ event: 'app.boot', appEnv: e.APP_ENV }, 'server starting');
      // 06 §3.4: Next's own start-server handler does the graceful part (stop accepting, wait for
      // in-flight requests, exit 143/130); this listener only logs. After stop_grace_period (20 s)
      // Docker sends SIGKILL, so an export still streaming then fails as a download (curl 18).
      const onSignal = (signal: NodeJS.Signals) => {
        logger.info({ event: 'app.shutdown', signal }, 'server stopping');
        // Never swallow the signal if Next's handler is absent (NEXT_MANUAL_SIG_HANDLE is unset).
        if (process.listenerCount(signal) === 0) process.exit(signal === 'SIGTERM' ? 143 : 130);
      };
      process.once('SIGTERM', onSignal);
      process.once('SIGINT', onSignal);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  }
}
