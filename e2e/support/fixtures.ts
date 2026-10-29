import {
  test as base,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { BROWSER_TIMEZONE, storageStatePath, type Persona } from './personas';

/** One persona signed in: a browser page plus an API client sharing the same session cookie. */
export interface PersonaSession {
  context: BrowserContext;
  page: Page;
  api: APIRequestContext;
}

/**
 * `as('asha')` opens a fresh browser context from TC-E00's storageState for that persona (07 §11:
 * one context per persona, so a journey can hand a claim from Asha to Ravi to Meera to Farah).
 * Every context is closed when the test ends.
 */
export const test = base.extend<{ as: (persona: Persona) => Promise<PersonaSession> }>({
  as: async ({ browser, baseURL }, provide) => {
    const opened: BrowserContext[] = [];
    await provide(async (persona) => {
      const context = await browser.newContext({
        baseURL,
        timezoneId: BROWSER_TIMEZONE,
        storageState: storageStatePath(persona),
      });
      opened.push(context);
      return { context, page: await context.newPage(), api: context.request };
    });
    await Promise.all(opened.map((c) => c.close()));
  },
});

export { expect } from '@playwright/test';
