import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionDir, STATE_FILE } from '../../../src/core/paths.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { deriveRunStatus } from '../../../src/core/sessions/run-status.js';
import { readyToApplyMessage } from '../../../src/cli/sessions/resolve.js';
import { applyBackupDir } from '../../../src/engine/orchestrator/apply/backup.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  applyRun,
  cli,
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

/** How long the blocked Apply holds if the test never kills it; a backstop, not a pace. */
const APPLY_HOLD_MS = 120_000;
const BLOCK_WAIT_MS = 60_000;
const CLI_TIMEOUT_MS = 90_000;

/** The checkout's own version of the brief's anchor, which Apply replaces. */
const ORIGINAL_GREET = 'export const original = true;\n';

/** The implementer writes both declared files at once and finishes. */
const IMPLEMENTER_SCRIPT = `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
`;

type HeldApply = {
  pid: number;
  run: Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
};

let fixture: StopContinueFixture | undefined;
let held: HeldApply | undefined;

afterEach(async () => {
  if (held !== undefined) {
    try {
      process.kill(-held.pid, 'SIGKILL');
    } catch {
      // The group already left.
    }
    await held.run;
  }
  held = undefined;
  vi.unstubAllEnvs();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

/**
 * Promotion writes each file through a temporary sibling opened with
 * `fs.promises.open`. While the arm file exists, the open of the marker's
 * temporary blocks before it creates anything: `src/greet.ts` sorts first, so
 * it is already in the checkout, and `src/marker.ts` is not. The preload then
 * writes the blocked file, which is what the test waits on before the kill.
 */
function writeBlockingPreload(target: StopContinueFixture, armPath: string, blockedPath: string) {
  const preload = join(target.tmpDir, 'apply-block.mjs');
  writeFileSync(
    preload,
    `import fs from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
globalThis.fetch = async () => { throw new Error('Network disabled in Apply E2E'); };
const open = fs.open;
fs.open = async (...args) => {
  const path = String(args[0]);
  if (existsSync(${JSON.stringify(armPath)}) &&
      dirname(path) === ${JSON.stringify(realpathSync(join(target.projectDir, 'src')))} &&
      basename(path).startsWith('.marker.ts.tmp.')) {
    writeFileSync(${JSON.stringify(blockedPath)}, String(process.pid));
    await delay(${APPLY_HOLD_MS});
  }
  return open(...args);
};
syncBuiltinESMExports();
`,
  );
  vi.stubEnv(
    'NODE_OPTIONS',
    `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`,
  );
}

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await delay(50);
  }
  return false;
}

/**
 * A real run that is ready to apply, then a headless Apply whose process group
 * is killed with SIGKILL between its `applying` record and its last checkout write.
 */
async function crashMidApply(target: StopContinueFixture) {
  mkdirSync(join(target.projectDir, 'src'));
  writeFileSync(target.greetPath, ORIGINAL_GREET);
  const armPath = join(target.tmpDir, 'arm-apply-block');
  const blockedPath = join(target.tmpDir, 'apply-blocked');
  writeBlockingPreload(target, armPath, blockedPath);

  const started = await cli(target, ['start', 'smoke'], { timeoutMs: CLI_TIMEOUT_MS });
  expect(started.exitCode, started.stderr).toBe(0);
  const sessionId = readActive(target.projectDir);
  if (sessionId === null) throw new Error(`the run left no active session: ${started.stderr}`);
  const ready = readState(target, sessionId);
  expect(deriveRunStatus({ state: ready, liveness: 'not-alive' }).kind).toBe('ready-to-apply');
  const workspace = ready.workspace;
  if (workspace === undefined) throw new Error('the run has no workspace');
  expect(workspace.kind).toBe('worktree');
  expect(readFileSync(target.greetPath, 'utf8')).toBe(ORIGINAL_GREET);
  expect(existsSync(target.markerPath)).toBe(false);

  writeFileSync(armPath, '');
  let pid: number | undefined;
  const run = cli(target, ['continue', sessionId, '--action', 'apply'], {
    timeoutMs: CLI_TIMEOUT_MS,
    onSpawn: (spawned) => {
      pid = spawned;
    },
  });
  if (pid === undefined) throw new Error('the Apply CLI reported no pid to signal');
  held = { pid, run };
  const blocked = await waitForFile(blockedPath, BLOCK_WAIT_MS);
  process.kill(-pid, 'SIGKILL');
  const killed = await run;
  held = undefined;
  rmSync(armPath);
  if (!blocked) {
    throw new Error(`Apply never reached the marker write: ${killed.stderr}`);
  }
  expect(killed.exitCode).toBeNull();

  const cut = readState(target, sessionId);
  const backupId = cut.applying?.backupId;
  if (backupId === undefined) throw new Error('the killed Apply left no applying record');
  expect(cut.pendingRecovery).toBeUndefined();
  expect(cut.closed).toBeUndefined();
  expect(deriveRunStatus({ state: cut, liveness: 'not-alive' })).toMatchObject({
    kind: 'open',
    stop: { kind: 'stopped', on: { kind: 'interrupted' } },
  });
  expect(
    existsSync(join(applyBackupDir(target.projectDir, sessionId, backupId), 'manifest.json')),
  ).toBe(true);
  expect(readFileSync(target.greetPath, 'utf8')).toBe(GREET_SOURCE);
  expect(existsSync(target.markerPath)).toBe(false);
  expect(existsSync(workspace.path)).toBe(true);

  const statePath = join(sessionDir(target.projectDir, sessionId), STATE_FILE);
  const stateBytes = readFileSync(statePath, 'utf8');
  const ended = await cli(target, ['continue', sessionId, '--action', 'end-run'], {
    timeoutMs: CLI_TIMEOUT_MS,
  });
  expect(ended.exitCode, ended.stderr).toBe(1);
  expect(ended.stderr).toContain('Restore or retry Apply first');
  expect(readFileSync(statePath, 'utf8')).toBe(stateBytes);
  const early = await cli(target, ['continue', sessionId, '--action', 'restore'], {
    timeoutMs: CLI_TIMEOUT_MS,
  });
  expect(early.exitCode, early.stderr).toBe(1);
  expect(early.stderr).toContain('No pending recovery issue is available.');
  expect(readFileSync(statePath, 'utf8')).toBe(stateBytes);

  const reopened = await cli(target, ['continue', sessionId], { timeoutMs: CLI_TIMEOUT_MS });
  expect(reopened.exitCode, reopened.stderr).toBe(1);
  expect(reopened.stderr).toContain('(apply-partial)');
  expect(reopened.stderr).toContain(
    `Continue with: splitbrief continue ${sessionId} --action retry`,
  );
  const halted = readState(target, sessionId);
  const issue = halted.pendingRecovery;
  expect(issue?.reason).toBe('apply-partial');
  expect(issue?.availableActions).toEqual(
    expect.arrayContaining(['retry-same-worker', 'restore-backup']),
  );
  expect(issue?.recommendedAction).toBe('retry-same-worker');
  const details = issue?.details.join('\n') ?? '';
  expect(details).toContain('Apply was cut off');
  expect(details).toContain(`${GREET_FILE} · written`);
  expect(details).toContain(`${MARKER_FILE} · not written`);
  expect(halted.applying?.backupId).toBe(backupId);
  expect(deriveRunStatus({ state: halted, liveness: 'not-alive' })).toMatchObject({
    kind: 'open',
    stop: { kind: 'waiting-for-you', on: { kind: 'halt' } },
  });
  expect(readFileSync(target.greetPath, 'utf8')).toBe(GREET_SOURCE);
  expect(existsSync(target.markerPath)).toBe(false);

  return { sessionId, backupId, workspacePath: workspace.path };
}

describe('Apply killed mid-write', { timeout: 240_000 }, () => {
  it('restores the checkout to its pre-Apply bytes and leaves the run ready to apply again', async () => {
    fixture = createStopContinueFixture(() => IMPLEMENTER_SCRIPT, { isolation: 'worktree' });
    const target = fixture;
    const { sessionId, workspacePath } = await crashMidApply(target);

    const restored = await cli(target, ['continue', sessionId, '--action', 'restore'], {
      timeoutMs: CLI_TIMEOUT_MS,
    });
    expect(restored.exitCode, restored.stderr).toBe(0);
    expect(restored.stderr).toContain(readyToApplyMessage(sessionId));
    expect(readFileSync(target.greetPath, 'utf8')).toBe(ORIGINAL_GREET);
    expect(existsSync(target.markerPath)).toBe(false);
    const ready = readState(target, sessionId);
    expect(ready.applying).toBeUndefined();
    expect(ready.pendingRecovery).toBeUndefined();
    expect(ready.closed).toBeUndefined();
    expect(deriveRunStatus({ state: ready, liveness: 'not-alive' }).kind).toBe('ready-to-apply');
    expect(existsSync(workspacePath)).toBe(true);

    const applied = await applyRun(target, sessionId);
    expect(applied.exitCode, applied.stderr).toBe(0);
    expect(readFileSync(target.greetPath, 'utf8')).toBe(GREET_SOURCE);
    expect(readFileSync(target.markerPath, 'utf8')).toBe(MARKER_SOURCE);
    expect(readState(target, sessionId).closed?.as).toBe('applied');
    expect(existsSync(workspacePath)).toBe(false);
  });

  it('retries the remaining writes with the same backup and closes the run applied', async () => {
    fixture = createStopContinueFixture(() => IMPLEMENTER_SCRIPT, { isolation: 'worktree' });
    const target = fixture;
    const { sessionId, backupId, workspacePath } = await crashMidApply(target);

    const retried = await cli(target, ['continue', sessionId, '--action', 'retry'], {
      timeoutMs: CLI_TIMEOUT_MS,
    });
    expect(retried.exitCode, retried.stderr).toBe(0);
    expect(readFileSync(target.greetPath, 'utf8')).toBe(GREET_SOURCE);
    expect(readFileSync(target.markerPath, 'utf8')).toBe(MARKER_SOURCE);
    const closed = readState(target, sessionId);
    expect(closed.closed?.as).toBe('applied');
    expect(closed.applied?.backupId).toBe(backupId);
    expect(closed.applying).toBeUndefined();
    expect(closed.pendingRecovery).toBeUndefined();
    expect(existsSync(workspacePath)).toBe(false);
  });
});
