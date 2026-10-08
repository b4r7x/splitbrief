import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withApplyRun, type ApplyRun } from '#testing/helpers/apply-run.js';
import { runBaseOf } from '../isolation/base-tree.js';
import { changedDefinitionRefusal } from './changed-script.js';

const PACKAGE = JSON.stringify({ scripts: { test: 'vitest run', lint: 'biome check' } });

function refusal(run: ApplyRun, command: string): Promise<string | null> {
  const base = runBaseOf({ projectDir: run.dir, sessionId: run.sessionId }, run);
  if (base === undefined) throw new Error('The run recorded no workspace base');
  return changedDefinitionRefusal({ command, base, workspaceDir: run.ws });
}

function writePackage(run: ApplyRun, scripts: Record<string, string>): void {
  writeFileSync(join(run.ws, 'package.json'), JSON.stringify({ scripts }));
}

describe('changedDefinitionRefusal', { timeout: 60_000 }, () => {
  it('admits a package script when package.json is the one the run started from', async () => {
    await withApplyRun(
      { 'package.json': PACKAGE },
      { sessionId: 'sess-script-same' },
      async (run) => {
        expect(await refusal(run, 'npm test')).toBeNull();
      },
    );
  });

  it('refuses a package script whose text this run changed', async () => {
    await withApplyRun(
      { 'package.json': PACKAGE },
      { sessionId: 'sess-script-text' },
      async (run) => {
        writePackage(run, { test: 'echo ok', lint: 'biome check' });

        expect(await refusal(run, 'npm test')).toBe(
          'runs the package script test, which this run changed',
        );
        expect(await refusal(run, 'pnpm run test')).toBe(
          'runs the package script test, which this run changed',
        );
      },
    );
  });

  it('admits a package script when the run changed only another script', async () => {
    await withApplyRun(
      { 'package.json': PACKAGE },
      { sessionId: 'sess-script-other' },
      async (run) => {
        writePackage(run, { test: 'vitest run', lint: 'echo ok' });

        expect(await refusal(run, 'npm test')).toBeNull();
        expect(await refusal(run, 'yarn lint')).toBe(
          'runs the package script lint, which this run changed',
        );
      },
    );
  });

  it('admits bun test, which runs bun’s own test runner and no package script', async () => {
    await withApplyRun(
      { 'package.json': PACKAGE },
      { sessionId: 'sess-script-bun' },
      async (run) => {
        writePackage(run, { test: 'echo ok', lint: 'biome check' });

        expect(await refusal(run, 'bun test')).toBeNull();
        expect(await refusal(run, 'bun run test')).toBe(
          'runs the package script test, which this run changed',
        );
      },
    );
  });

  it('refuses make when the run changed the Makefile', async () => {
    await withApplyRun(
      { Makefile: 'test:\n\tpytest\n' },
      { sessionId: 'sess-make-changed' },
      async (run) => {
        expect(await refusal(run, 'make test')).toBeNull();
        writeFileSync(join(run.ws, 'Makefile'), 'test:\n\ttrue\n');

        expect(await refusal(run, 'make test')).toBe(
          'runs make on Makefile, which this run changed',
        );
      },
    );
  });

  it('refuses make when the run created the Makefile', async () => {
    await withApplyRun({ 'src/a.py': 'a = 1\n' }, { sessionId: 'sess-make-new' }, async (run) => {
      expect(await refusal(run, 'make test')).toBeNull();
      writeFileSync(join(run.ws, 'Makefile'), 'test:\n\ttrue\n');

      expect(await refusal(run, 'make test')).toBe('runs make on Makefile, which this run changed');
    });
  });

  it('admits a command that runs no script or task file', async () => {
    await withApplyRun(
      { 'package.json': PACKAGE },
      { sessionId: 'sess-script-none' },
      async (run) => {
        writePackage(run, { test: 'echo ok' });

        expect(await refusal(run, 'npx --no-install vitest run')).toBeNull();
        expect(await refusal(run, 'pytest')).toBeNull();
      },
    );
  });
  it('refuses npm test when the run changed its pretest or posttest script, and only for npm', async () => {
    await withApplyRun(
      { 'package.json': PACKAGE },
      { sessionId: 'sess-script-pre-post' },
      async (run) => {
        writePackage(run, { pretest: 'echo setup', test: 'vitest run', lint: 'biome check' });
        expect(await refusal(run, 'npm test')).toBe(
          'runs the package script test with its pretest script, which this run changed',
        );
        expect(await refusal(run, 'pnpm test')).toBeNull();

        writePackage(run, { test: 'vitest run', posttest: 'echo done', lint: 'biome check' });
        expect(await refusal(run, 'npm run test')).toBe(
          'runs the package script test with its posttest script, which this run changed',
        );
      },
    );
  });

  it('refuses a package script when the run left package.json unreadable', async () => {
    await withApplyRun(
      { 'package.json': PACKAGE },
      { sessionId: 'sess-script-malformed' },
      async (run) => {
        writeFileSync(join(run.ws, 'package.json'), '{ "scripts": ');

        expect(await refusal(run, 'npm test')).toBe(
          'runs the package script test, and this run changed package.json',
        );
      },
    );
  });

  it('refuses just when the run changed the Justfile', async () => {
    await withApplyRun(
      { Justfile: 'test:\n\tcargo test\n' },
      { sessionId: 'sess-just-changed' },
      async (run) => {
        expect(await refusal(run, 'just test')).toBeNull();
        writeFileSync(join(run.ws, 'Justfile'), 'test:\n\ttrue\n');

        expect(await refusal(run, 'just test')).toBe(
          'runs just on Justfile, which this run changed',
        );
      },
    );
  });

  it('compares with the package.json the run base itself holds, not the checkout baseline', async () => {
    await withApplyRun(
      { 'package.json': PACKAGE },
      {
        sessionId: 'sess-script-base-blob',
        atBase: (dir) =>
          writeFileSync(
            join(dir, 'package.json'),
            JSON.stringify({ scripts: { test: 'vitest run --reporter dot', lint: 'biome check' } }),
          ),
      },
      async (run) => {
        writePackage(run, { test: 'vitest run --reporter dot', lint: 'echo ok' });

        expect(await refusal(run, 'npm test')).toBeNull();
        expect(await refusal(run, 'npm run lint')).toBe(
          'runs the package script lint, which this run changed',
        );
      },
    );
  });
});
