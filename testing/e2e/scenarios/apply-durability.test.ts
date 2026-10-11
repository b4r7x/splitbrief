import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  cli,
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

let fixture: StopContinueFixture | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

it('keeps checkout bytes on a promotion fsync failure and completes Apply on retry', async () => {
  fixture = createStopContinueFixture(
    () => `import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
chmodSync(${JSON.stringify(MARKER_FILE)}, 0o755);
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
`,
  );
  const target = fixture;
  mkdirSync(join(target.projectDir, 'src'));
  const original = 'export const original = true;\n';
  writeFileSync(target.greetPath, original);
  const failSync = join(target.tmpDir, 'fail-sync');
  const preload = join(target.tmpDir, 'promotion-sync.mjs');
  writeFileSync(
    preload,
    `import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
globalThis.fetch = async () => { throw new Error('Network disabled in Apply E2E'); };
const open = fs.open;
fs.open = async (...args) => {
  const handle = await open(...args);
  const path = String(args[0]);
  if (existsSync(${JSON.stringify(failSync)}) &&
      dirname(path) === ${JSON.stringify(realpathSync(join(target.projectDir, 'src')))} &&
      basename(path).startsWith('.greet.ts.tmp.')) {
    handle.sync = async () => { throw new Error('simulated promotion fsync failure'); };
  }
  return handle;
};
syncBuiltinESMExports();
`,
  );
  vi.stubEnv(
    'NODE_OPTIONS',
    `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`,
  );

  const started = await cli(target, ['start', 'smoke'], { timeoutMs: 90_000 });
  expect(started.exitCode, started.stderr).toBe(0);
  const sessionId = readActive(target.projectDir);
  if (sessionId === null) throw new Error(`the run left no active session: ${started.stderr}`);
  const workspace = readState(target, sessionId).workspace;
  if (workspace === undefined) throw new Error('the run has no workspace');
  expect(readFileSync(target.greetPath, 'utf8')).toBe(original);
  expect(existsSync(target.markerPath)).toBe(false);

  writeFileSync(failSync, '');
  const failed = await cli(target, ['continue', sessionId, '--action', 'apply']);
  expect(failed.exitCode, failed.stderr).toBe(1);
  expect(failed.stderr).toContain('apply-partial');
  const partial = readState(target, sessionId);
  expect(partial.pendingRecovery?.reason).toBe('apply-partial');
  expect(partial.pendingRecovery?.details.join('\n')).toContain(
    'simulated promotion fsync failure',
  );
  expect(partial.applying?.backupId).toBeDefined();
  expect(partial.closed).toBeUndefined();
  expect(readFileSync(target.greetPath, 'utf8')).toBe(original);
  expect(existsSync(target.markerPath)).toBe(false);
  expect(existsSync(workspace.path)).toBe(true);

  rmSync(failSync);
  const retried = await cli(target, ['continue', sessionId, '--action', 'retry']);
  expect(retried.exitCode, retried.stderr).toBe(0);
  expect(readFileSync(target.greetPath, 'utf8')).toBe(GREET_SOURCE);
  expect(readFileSync(target.markerPath, 'utf8')).toBe(MARKER_SOURCE);
  expect(statSync(target.markerPath).mode & 0o777).toBe(0o755);
  const applied = readState(target, sessionId);
  expect(applied.closed?.as).toBe('applied');
  expect(applied.applied?.backupId).toBe(partial.applying?.backupId);
  expect(existsSync(workspace.path)).toBe(false);
}, 180_000);
