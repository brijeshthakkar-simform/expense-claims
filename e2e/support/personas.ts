import { fileURLToPath } from 'node:url';

/** The seeded cast the journeys use (C-15); the same accounts as the README and Vitest. */
export const PERSONAS = {
  asha: { email: 'asha.rao@acme.test', name: 'Asha Rao' },
  ravi: { email: 'ravi.menon@acme.test', name: 'Ravi Menon' },
  meera: { email: 'meera.iyer@acme.test', name: 'Meera Iyer' },
  neha: { email: 'neha.kapoor@acme.test', name: 'Neha Kapoor' },
  farah: { email: 'farah.khan@acme.test', name: 'Farah Khan' },
} as const;

export type Persona = keyof typeof PERSONAS;

export const PERSONA_NAMES = Object.keys(PERSONAS) as Persona[];

/** e2e/.auth/<persona>.json, written by TC-E00 (gitignored). */
export const storageStatePath = (p: Persona): string =>
  fileURLToPath(new URL(`../.auth/${p}.json`, import.meta.url));

/** The browser zone every context runs in (07 §11): far from IST on purpose. */
export const BROWSER_TIMEZONE = 'America/Los_Angeles';
