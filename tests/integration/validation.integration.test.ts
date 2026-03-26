import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { guardIntegration } from './guard.js';
import { createFixtureProject, type FixtureProject } from './helpers.js';

const exec = promisify(execFile);

describe('validation pipeline integration', { timeout: 30_000 }, () => {
  let fixture: FixtureProject | undefined;

  afterEach(async () => {
    if (fixture) {
      await fixture.cleanup();
      fixture = undefined;
    }
  });

  it('tsc passes on valid fixture project', { timeout: 30_000 }, async (t) => {
    const guard = await guardIntegration();
    if (guard.skip) { t.skip(guard.skip); return; }

    fixture = await createFixtureProject();
    const { exitCode } = await exec('npx', ['tsc', '--noEmit'], { cwd: fixture.dir })
      .then((r) => ({ ...r, exitCode: 0 }))
      .catch((err) => ({ ...err, exitCode: err.code ?? 1 }));

    assert.equal(exitCode, 0, 'tsc should pass on valid project');
  });

  it('tsc fails on invalid TypeScript', { timeout: 30_000 }, async (t) => {
    const guard = await guardIntegration();
    if (guard.skip) { t.skip(guard.skip); return; }

    fixture = await createFixtureProject();

    const badCode = `export function broken(x: number): string {\n  return x * 2;\n}\n`;
    await writeFile(join(fixture.dir, 'src', 'broken.ts'), badCode);

    let exitCode = 0;
    try {
      await exec('npx', ['tsc', '--noEmit'], { cwd: fixture.dir });
    } catch (err: unknown) {
      exitCode = (err as { code?: number }).code ?? 1;
    }

    assert.notEqual(exitCode, 0, 'tsc should fail on type error');
  });
});
