import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import XtermHeadless from '@xterm/headless';
import { afterEach, expect, it, vi } from 'vitest';
import { sessionDir } from '../../../src/core/paths.js';
import { sessionLockfilePath } from '../../../src/core/sessions/lockfile-status.js';
import { readRunRecord } from '../../../src/core/sessions/run-record-io.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { saveState } from '../../../src/core/state/persistence.js';
import { acquireLiveness } from '../../../src/engine/orchestrator/run/liveness.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../src/lib/terminal/typeahead-grace.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { RUN_CREW } from '#testing/helpers/factories/workflow-state.js';
import { spawnCli } from '../helpers/live-cli-harness.js';
import { seedReadyRun } from '../helpers/applying-run.js';
import {
  createStopContinueFixture,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const APPLY_RAIL = '● Plan → ● Build → ● Review → ● Apply';

let fixture: StopContinueFixture | undefined;

afterEach(() => {
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

/**
 * While the hold file exists, the call that moves b.txt's temporary into place waits. The
 * preload writes the blocked file first, which is what the test waits on.
 */
function writeBlockingPreload(target: StopContinueFixture, holdPath: string, blockedPath: string) {
  const preload = join(target.tmpDir, 'apply-hold.mjs');
  writeFileSync(
    preload,
    `import fs from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
globalThis.fetch = async () => { throw new Error('Network disabled in Apply E2E'); };
for (const call of ['link', 'rename']) {
  const original = fs[call];
  fs[call] = async (...args) => {
    const path = String(args[0]);
    if (dirname(path) === ${JSON.stringify(realpathSync(target.projectDir))} &&
        basename(path).startsWith('.b.txt.tmp.')) {
      writeFileSync(${JSON.stringify(blockedPath)}, String(process.pid));
      while (existsSync(${JSON.stringify(holdPath)})) await delay(50);
    }
    return original(...args);
  };
}
syncBuiltinESMExports();
`,
  );
  return preload;
}

interface Cli {
  screen: () => string;
  write: (keys: string) => void;
  waitForText: (text: string) => Promise<void>;
  exited: Promise<PtyExitEvent>;
}

/** Starts the built CLI on the fixture, opens its one run from the sessions list and hands it on. */
async function openRunFromSessions<T>(
  target: StopContinueFixture,
  preload: readonly string[],
  drive: (cli: Cli) => Promise<T>,
): Promise<T> {
  const home = join(target.tmpDir, 'home');
  mkdirSync(home);
  const viewport = { cols: 120, rows: 40 };
  const result = await runWithPtyChild(
    {
      requirement: 'required',
      argv: [...preload, 'dist/cli.js', '--project', target.projectDir],
      spawnOptions: {
        name: 'xterm-256color',
        ...viewport,
        cwd: resolve(import.meta.dirname, '../../..'),
        env: { ...safeChildEnvironment(home), XDG_STATE_HOME: target.stateHome },
      },
    },
    async (child) => {
      const terminal = new XtermHeadless.Terminal({
        ...viewport,
        allowProposedApi: true,
        logLevel: 'off',
      });
      const exited = Promise.withResolvers<PtyExitEvent>();
      const screen = () =>
        Array.from(
          { length: viewport.rows },
          (_, row) =>
            terminal.buffer.active
              .getLine(terminal.buffer.active.viewportY + row)
              ?.translateToString(true) ?? '',
        ).join('\n');
      const data = child.onData((chunk) => terminal.write(chunk));
      const exit = child.onExit((event) => exited.resolve(event));
      const waitForText = async (text: string) => {
        await vi.waitFor(() => expect(screen()).toContain(text), { timeout: 30_000 });
      };
      try {
        await waitForText('Describe your feature');
        child.write('/sessions');
        await waitForText('/sessions');
        await delay(PROMPT_TYPEAHEAD_GRACE_MS);
        child.write('\r');
        await waitForText('Sessions · 1');
        await delay(PROMPT_TYPEAHEAD_GRACE_MS);
        child.write('\r');
        return {
          value: await drive({
            screen,
            write: (keys) => child.write(keys),
            waitForText,
            exited: exited.promise,
          }),
        };
      } finally {
        await terminatePtyProcessGroup(child, exited.promise);
        data.dispose();
        exit.dispose();
        terminal.dispose();
      }
    },
  );
  if (!('value' in result)) throw new Error(result.reason);
  return result.value;
}

/**
 * Opens the ready run from home, picks Apply, and types `keys` one by one while Apply is held. The
 * screen is read while held, then the hold is released and `settle` reads the end.
 */
async function applyWhileHeld(
  keys: readonly string[],
  settle: (screen: () => string, exited: Promise<PtyExitEvent>) => Promise<void>,
) {
  const target = createStopContinueFixture(() => '', { isolation: 'staged-copy' });
  fixture = target;
  const ready = await seedReadyRun(target);
  const holdPath = join(target.tmpDir, 'hold-apply');
  const blockedPath = join(target.tmpDir, 'apply-blocked');
  writeFileSync(holdPath, '');
  const preload = writeBlockingPreload(target, holdPath, blockedPath);
  const result = await openRunFromSessions(
    target,
    ['--import', preload],
    async ({ screen, write, waitForText, exited }) => {
      let exitedEarly = false;
      void exited.then(() => {
        exitedEarly = existsSync(holdPath);
      });
      try {
        await waitForText('Ready to apply');
        await delay(PROMPT_TYPEAHEAD_GRACE_MS);
        write('\r');
        await vi.waitFor(() => expect(existsSync(blockedPath), screen()).toBe(true), {
          timeout: 30_000,
        });
        await waitForText('Applying to your checkout');
        const applying = screen();
        for (const key of keys) {
          write(key);
          await delay(PROMPT_TYPEAHEAD_GRACE_MS);
        }
        await delay(1_000);
        const held = screen();
        const heldStatus = readState(target, ready.ref.sessionId);
        rmSync(holdPath);
        await settle(screen, exited);
        return { applying, held, heldStatus, exitedEarly };
      } finally {
        rmSync(holdPath, { force: true });
      }
    },
  );
  return { ...result, target, ready };
}

function expectApplyingScreen(screen: string) {
  expect(screen.split('\n')[0]).toContain(APPLY_RAIL);
  expect(screen).toContain('Applying to your checkout');
  expect(screen).not.toContain('Stopped at Apply');
  expect(screen).not.toContain('Ready to apply');
  expect(screen).not.toContain('⏎ to continue');
  expect(screen).not.toContain('Session options');
}

function expectApplied(target: StopContinueFixture, sessionId: string) {
  expect(readState(target, sessionId).closed).toMatchObject({ as: 'applied' });
  expect(readFileSync(join(target.projectDir, 'a.txt'), 'utf8')).toBe('run result\n');
  expect(readFileSync(join(target.projectDir, 'b.txt'), 'utf8')).toBe('run result\n');
  expect(readdirSync(target.projectDir).filter((name) => name.includes('.tmp.'))).toEqual([]);
}

it('keeps the run screen while Apply writes and quits on Ctrl+C only after Apply finishes', async () => {
  const { applying, held, heldStatus, target, ready, exitedEarly } = await applyWhileHeld(
    ['\x03', '\x03'],
    async (_screen, exited) => {
      const exit = await Promise.race([exited, delay(30_000, null)]);
      expect(exit).toMatchObject({ exitCode: 0 });
    },
  );
  expectApplyingScreen(applying);
  expectApplyingScreen(held);
  expect(held).toContain('Quits when Apply finishes');
  expect(heldStatus.closed).toBeUndefined();
  expect(exitedEarly).toBe(false);
  expectApplied(target, ready.ref.sessionId);
});

it('keeps the run screen on Esc while Apply writes, then goes home and lists the run as applied', async () => {
  const { applying, held, target, ready, exitedEarly } = await applyWhileHeld(
    ['\x1b', '\x1b'],
    async (screen) => {
      await vi.waitFor(
        () => {
          expect(screen()).toContain('Describe your feature');
          expect(screen()).toContain('applied');
        },
        { timeout: 30_000 },
      );
    },
  );
  expectApplyingScreen(applying);
  expectApplyingScreen(held);
  expect(held).toContain('Returns home when Apply finishes');
  expect(exitedEarly).toBe(false);
  expectApplied(target, ready.ref.sessionId);
});

it('keeps the run screen on a typed /home while Apply writes, then goes home once Apply applies the run', async () => {
  const { applying, held, target, ready, exitedEarly } = await applyWhileHeld(
    ['/home', '\r'],
    async (screen) => {
      await vi.waitFor(
        () => {
          expect(screen()).toContain('Describe your feature');
          expect(screen()).toContain('applied');
        },
        { timeout: 30_000 },
      );
    },
  );
  expectApplyingScreen(applying);
  expectApplyingScreen(held);
  expect(held).toContain('Returns home when Apply finishes');
  expect(exitedEarly).toBe(false);
  expectApplied(target, ready.ref.sessionId);
});

it('names the whole reason first when the sessions list refuses a pick while Apply writes', async () => {
  const target = createStopContinueFixture(() => '', { isolation: 'staged-copy' });
  fixture = target;
  await seedReadyRun(target);
  const holdPath = join(target.tmpDir, 'hold-apply');
  const blockedPath = join(target.tmpDir, 'apply-blocked');
  writeFileSync(holdPath, '');
  const preload = writeBlockingPreload(target, holdPath, blockedPath);
  const refused = await openRunFromSessions(
    target,
    ['--import', preload],
    async ({ screen, write, waitForText }) => {
      try {
        await waitForText('Ready to apply');
        await delay(PROMPT_TYPEAHEAD_GRACE_MS);
        write('\r');
        await vi.waitFor(() => expect(existsSync(blockedPath), screen()).toBe(true), {
          timeout: 30_000,
        });
        await waitForText('Applying to your checkout');
        saveState(
          { projectDir: target.projectDir, sessionId: 'long-task' },
          createInitialState(
            'Add generated JSON data fixtures, as one task:\n\n- Add `scripts/gen-json.js` (CommonJS) that writes them',
          ),
        );
        write('/sessions');
        await waitForText('/sessions');
        await delay(PROMPT_TYPEAHEAD_GRACE_MS);
        write('\r');
        await waitForText('Sessions · 2');
        await delay(PROMPT_TYPEAHEAD_GRACE_MS);
        // Where the cursor starts depends on when an Apply heartbeat refreshes the list, so the
        // filter selects the long task by its text.
        write('fixtures');
        await waitForText('▌ ◌ Add generated JSON');
        await delay(PROMPT_TYPEAHEAD_GRACE_MS);
        write('\r');
        await waitForText('Cannot open "Add generated JSON');
        return screen();
      } finally {
        rmSync(holdPath, { force: true });
      }
    },
  );
  expect(refused).toContain(
    'Apply is still writing to your checkout. Cannot open "Add generated JSON data',
  );
  expect(refused).toContain('Add generated JSON data fixtures, as one task: - Add');
  expect(refused).toContain('Sessions · 2');
});

it('goes home at once from a run another process applies, and names that process', async () => {
  const target = createStopContinueFixture(() => '', { isolation: 'staged-copy' });
  fixture = target;
  const ready = await seedReadyRun(target);
  const offline = join(target.tmpDir, 'offline.mjs');
  writeFileSync(
    offline,
    "globalThis.fetch = async () => { throw new Error('Network disabled in Apply E2E'); };\n",
  );
  // The test process holds the run, as another window does while its Apply writes the checkout.
  const release = await acquireLiveness({ ...ready.ref, feature: 'Apply the run' });
  try {
    const opened = await openRunFromSessions(
      target,
      ['--import', offline],
      async ({ screen, write, waitForText }) => {
        await waitForText('Running in another process');
        const run = screen();
        await delay(PROMPT_TYPEAHEAD_GRACE_MS);
        write('\r');
        await waitForText('Describe your feature');
        return run;
      },
    );
    expect(opened.split('\n')[0]).toContain(APPLY_RAIL);
    expect(opened).toContain('/ for a command · ⏎ for home…');
    expect(opened).not.toContain('Applying to your checkout');
    expect(opened).not.toContain('when Apply finishes');
    expect(readState(target, ready.ref.sessionId).closed).toBeUndefined();
  } finally {
    await release();
  }
});

it('leaves "Running in another process" once that process dies without a word on disk', async () => {
  const target = createStopContinueFixture(() => '', { isolation: 'staged-copy' });
  fixture = target;
  const ready = await seedReadyRun(target);
  const offline = join(target.tmpDir, 'offline.mjs');
  writeFileSync(
    offline,
    "globalThis.fetch = async () => { throw new Error('Network disabled in Apply E2E'); };\n",
  );
  // Another window holds the run while its Apply writes, then is killed (Force Quit, kill -9):
  // no exit handler runs, so nothing on disk says it stopped.
  const heldPath = join(target.tmpDir, 'held');
  const holderScript = join(target.tmpDir, 'holder.mts');
  writeFileSync(
    holderScript,
    `import { writeFileSync } from 'node:fs';
import { acquireLiveness } from ${JSON.stringify(resolve(import.meta.dirname, '../../../src/engine/orchestrator/run/liveness.ts'))};
await acquireLiveness(${JSON.stringify({ ...ready.ref, feature: 'Apply the run' })});
writeFileSync(${JSON.stringify(heldPath)}, String(process.pid));
setInterval(() => {}, 1000);
`,
  );
  const holder = spawn(process.execPath, ['--import', 'tsx', holderScript], {
    cwd: resolve(import.meta.dirname, '../../..'),
    stdio: 'ignore',
  });
  const holderExited = new Promise<void>((done) => holder.once('exit', () => done()));
  try {
    await vi.waitFor(() => expect(existsSync(heldPath)).toBe(true), { timeout: 30_000 });
    const lockPath = sessionLockfilePath(sessionDir(ready.ref.projectDir, ready.ref.sessionId));
    const { owned, killedLock, after } = await openRunFromSessions(
      target,
      ['--import', offline],
      async ({ screen, waitForText }) => {
        await waitForText('Running in another process');
        const owned = screen();
        holder.kill('SIGKILL');
        await holderExited;
        const killedLock = readFileSync(lockPath, 'utf8');
        await waitForText('Ready to apply');
        return { owned, killedLock, after: screen() };
      },
    );
    expect(owned).toContain('/ for a command · ⏎ for home…');
    // The window saw the dead owner by itself: the lockfile still names it, unchanged.
    expect(readFileSync(lockPath, 'utf8')).toBe(killedLock);
    expect(JSON.parse(killedLock)).not.toHaveProperty('exitedAt');
    expect(after).not.toContain('Running in another process');
    expect(after).toContain('Show diff');
    expect(readState(target, ready.ref.sessionId).closed).toBeUndefined();
  } finally {
    holder.kill('SIGKILL');
    await holderExited;
  }
});

it('finishes a headless Apply a SIGTERM reaches, exits 143 and leaves the run not running', async () => {
  const target = createStopContinueFixture(() => '', { isolation: 'staged-copy' });
  fixture = target;
  const ready = await seedReadyRun(target);
  // A real run records its crew at start; the closed record names it.
  saveState(ready.ref, { ...readState(target, ready.ref.sessionId), ...RUN_CREW });
  const holdPath = join(target.tmpDir, 'hold-apply');
  const blockedPath = join(target.tmpDir, 'apply-blocked');
  writeFileSync(holdPath, '');
  const preload = writeBlockingPreload(target, holdPath, blockedPath);
  let pid: number | undefined;
  const run = spawnCli({
    args: [
      '--import',
      preload,
      '--import',
      'tsx',
      'src/cli.ts',
      'continue',
      ready.ref.sessionId,
      '--action',
      'apply',
      '--plain',
      '--project',
      target.projectDir,
    ],
    stateHome: target.stateHome,
    timeoutMs: 60_000,
    onSpawn: (spawned) => {
      pid = spawned;
    },
  });
  await vi.waitFor(() => expect(existsSync(blockedPath)).toBe(true), { timeout: 60_000 });
  if (pid === undefined) throw new Error('the CLI reported no pid to signal');
  process.kill(pid, 'SIGTERM');
  await delay(500);
  rmSync(holdPath);

  const outcome = await run;

  expect(outcome.exitCode, outcome.stderr).toBe(143);
  expect(outcome.stderr.split('\n')).toContain('Applied 2 files to your checkout.');
  expectApplied(target, ready.ref.sessionId);
  const lock = readFileSync(
    sessionLockfilePath(sessionDir(ready.ref.projectDir, ready.ref.sessionId)),
    'utf8',
  );
  expect(JSON.parse(lock).exitedAt).toBeTypeOf('number');
  expect(readRunRecord(ready.ref).status.kind).toBe('closed');
});
