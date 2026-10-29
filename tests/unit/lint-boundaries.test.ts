// TC-U10: the layering rules in eslint.config.mjs (01 §7, D-03) fail lint; they are not a convention.
import { fileURLToPath } from 'node:url';
import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

// The fixtures are virtual files. typescript-eslint's project service only resolves files that exist
// on disk, so type-aware rules are switched off for them. The boundary rules under test are
// syntactic and come from the real repo config unchanged.
const eslint = new ESLint({
  cwd: repoRoot,
  overrideConfig: [tseslint.configs.disableTypeChecked as Linter.Config],
});

async function lint(filePath: string, code: string): Promise<Linter.LintMessage[]> {
  const [result] = await eslint.lintText(code, { filePath, warnIgnored: true });
  if (!result) throw new Error(`ESLint returned no result for ${filePath}`);
  expect(result.messages.filter((m) => m.fatal === true)).toEqual([]);
  return result.messages;
}

const messagesOf = (rule: string, messages: Linter.LintMessage[]) =>
  messages.filter((m) => m.ruleId === rule).map((m) => m.message);

// Several zone patterns may match one import; each reports, so assert containment.
const expectImportBlocked = (messages: Linter.LintMessage[], specifier: string) =>
  expect(messagesOf('no-restricted-imports', messages), specifier).toContainEqual(
    expect.stringContaining(`'${specifier}' import is restricted`),
  );

const expectImportAllowed = (messages: Linter.LintMessage[], specifier: string) =>
  expect(messagesOf('no-restricted-imports', messages), specifier).toEqual([]);

const component = (specifier: string, name: string) => `import { ${name} } from '${specifier}';

export default function Fixture() {
  return <p>{String(${name})}</p>;
}
`;

describe('TC-U10 lint boundaries', { timeout: 60_000 }, () => {
  it('importing @/generated/prisma from src/app fails lint', async () => {
    const page = 'src/app/(app)/claims/lint-fixture.tsx';
    for (const specifier of ['@/generated/prisma/client', '@prisma/client', '@/server/db/client']) {
      expectImportBlocked(await lint(page, component(specifier, 'x')), specifier);
    }
    // Positive control: the one server module pages and layouts may use.
    expectImportAllowed(await lint(page, component('@/server/auth/rsc', 'getActor')), 'rsc');
  });

  it('importing @/server from src/components fails lint', async () => {
    const file = 'src/components/lint-fixture.tsx';
    for (const specifier of ['@/server/env', '@/server/db/client', '@/server/auth/rsc']) {
      expectImportBlocked(await lint(file, component(specifier, 'x')), specifier);
    }
    expectImportAllowed(await lint(file, component('@/shared/money', 'formatMinor')), 'shared');
  });

  it("a 'use server' directive fails lint", async () => {
    const moduleLevel = await lint(
      'src/app/(app)/claims/actions.ts',
      `'use server';

export async function approve(id: string) {
  return id;
}
`,
    );
    expect(messagesOf('no-restricted-syntax', moduleLevel)).toEqual([
      expect.stringContaining('Server Actions are banned'),
    ]);

    const inline = await lint(
      'src/features/claims/lint-fixture.tsx',
      `export function Form() {
  async function save(data: FormData) {
    'use server';
    return data;
  }
  return <form action={save} />;
}
`,
    );
    expect(messagesOf('no-restricted-syntax', inline)).toEqual([
      expect.stringContaining('Server Actions are banned'),
    ]);
  });

  it("a 'use cache' directive fails lint", async () => {
    const moduleLevel = await lint(
      'src/app/(app)/claims/lint-fixture.tsx',
      `'use cache';

export default function Page() {
  return <p>cached</p>;
}
`,
    );
    expect(messagesOf('no-restricted-syntax', moduleLevel)).toEqual([
      expect.stringContaining("'use cache' is banned"),
    ]);

    const inline = await lint(
      'src/server/services/lint-fixture.service.ts',
      `export async function listClaims() {
  'use cache';
  return [];
}
`,
    );
    expect(messagesOf('no-restricted-syntax', inline)).toEqual([
      expect.stringContaining("'use cache' is banned"),
    ]);
  });
});
