import { expect, request, test as setup } from '@playwright/test';
import { PERSONA_NAMES, PERSONAS, storageStatePath } from './support/personas';

// TC-E00 (07 §6.4, 05 §15.3): every persona signs in once through the real login API, and the
// journeys reuse the saved cookie instead of typing a password in every test (D-44).
setup('saves storageState for asha, ravi, meera, neha and farah', async ({ baseURL }) => {
  const password = process.env.SEED_DEMO_PASSWORD;
  expect(password, 'SEED_DEMO_PASSWORD (from .env) is set').toBeTruthy();

  for (const name of PERSONA_NAMES) {
    // A fresh client per persona, so each file holds exactly one session cookie.
    const api = await request.newContext({ baseURL });
    try {
      const res = await api.post('/api/v1/auth/login', {
        data: { email: PERSONAS[name].email, password },
      });
      expect(res.status(), `login as ${name}: ${await res.text()}`).toBe(200);
      const { data } = (await res.json()) as { data: { user: { email: string } } };
      expect(data.user.email).toBe(PERSONAS[name].email);

      const me = await api.get('/api/v1/auth/me');
      expect(me.status(), `${name}'s session works`).toBe(200);
      await api.storageState({ path: storageStatePath(name) });
    } finally {
      await api.dispose();
    }
  }
});
