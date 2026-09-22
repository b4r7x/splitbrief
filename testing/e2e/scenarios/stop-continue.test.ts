import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_LOG_FILE, STATE_FILE, sessionDir } from '../../../src/core/paths.js';
import {
  type SessionLogEventEntry,
  SessionLogEventEntrySchema,
} from '../../../src/core/schemas/session-log.js';
import {
  type PersistedWorkflowState,
  WorkflowStateSchema,
} from '../../../src/core/schemas/workflow.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { isRecord } from '../../../src/utils/type-guards.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { spawnCli } from '../helpers/live-cli-harness.js';
import { assertPlainStdout } from '../helpers/run-dir-assertions.js';
import {
  createStopContinueFixture,
  GREET_SOURCE,
  MARKER_FILE,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const START_TIMEOUT_MS = 60_000;
const CONTINUE_TIMEOUT_MS = 60_000;
const MARKER_WAIT_MS = 45_000;

let fixture: StopContinueFixture | undefined;

afterEach(() => {
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

/**
 * Starts the run, waits until the implementer has written its marker — which is
 * only true once the brief is executing — and then signals the whole process
 * group so the tool subprocess goes with the CLI.
 */
async function startAndSignal(
  target: StopContinueFixture,
  signal: NodeJS.Signals,
): Promise<{ exitCode: number | null; stdout: string; sessionId: string }> {
  let groupPid: number | undefined;
  const run = spawnCli({
    args: [
      '--import',
      'tsx',
      'src/cli.ts',
      'start',
      '--plain',
      '--mode',
      'quick',
      '--approve',
      'none',
      '--allow-repo-runners',
      '--project',
      target.projectDir,
      'smoke',
    ],
    stateHome: target.stateHome,
    timeoutMs: START_TIMEOUT_MS,
    onSpawn: (pid) => {
      groupPid = pid;
    },
  });

  await waitForIsolatedMarker(target, MARKER_WAIT_MS);
  if (groupPid === undefined) throw new Error('the CLI reported no pid to signal');
  process.kill(-groupPid, signal);

  const outcome = await run;
  const sessionId = readActive(target.projectDir);
  if (sessionId === null) {
    throw new Error(`the interrupted run left no active session: ${outcome.stderr}`);
  }
  return { exitCode: outcome.exitCode, stdout: outcome.stdout, sessionId };
}

function continueRun(target: StopContinueFixture): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  return spawnCli({
    args: [
      '--import',
      'tsx',
      'src/cli.ts',
      'continue',
      '--plain',
      '--allow-repo-runners',
      '--project',
      target.projectDir,
    ],
    stateHome: target.stateHome,
    timeoutMs: CONTINUE_TIMEOUT_MS,
  });
}

/**
 * The brief runs in the run's isolation worktree, and nothing reaches the project until its
 * changes are promoted — so the marker's first appearance is there, inside the implementer's hold.
 */
async function waitForIsolatedMarker(
  target: StopContinueFixture,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (findIsolatedMarker(target.isolationTreesDir) !== null) return;
    await delay(100);
  }
  throw new Error(
    `the implementer never wrote ${MARKER_FILE} under ${target.isolationTreesDir} within ${timeoutMs}ms`,
  );
}

function findIsolatedMarker(dir: string): string | null {
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile() && path.endsWith(MARKER_FILE)) return path;
    if (entry.isDirectory() && entry.name !== '.git') {
      const found = findIsolatedMarker(path);
      if (found !== null) return found;
    }
  }
  return null;
}

function readState(target: StopContinueFixture, sessionId: string): PersistedWorkflowState {
  const file = join(sessionDir(target.projectDir, sessionId), STATE_FILE);
  return WorkflowStateSchema.parse(JSON.parse(readFileSync(file, 'utf-8')));
}

function readEvents(
  target: StopContinueFixture,
  sessionId: string,
): readonly SessionLogEventEntry[] {
  const file = join(sessionDir(target.projectDir, sessionId), SESSION_LOG_FILE);
  const entries: SessionLogEventEntry[] = [];
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (line.trim() === '') continue;
    const parsed = SessionLogEventEntrySchema.safeParse(JSON.parse(line));
    if (parsed.success) entries.push(parsed.data);
  }
  return entries;
}

function warningsWithCode(
  events: readonly SessionLogEventEntry[],
  code: string,
): readonly SessionLogEventEntry[] {
  return events.filter(
    (entry) => entry.type === 'warning' && isRecord(entry.data) && entry.data.code === code,
  );
}

function warningMessages(events: readonly SessionLogEventEntry[]): readonly string[] {
  const messages: string[] = [];
  for (const entry of events) {
    if (entry.type !== 'warning' || !isRecord(entry.data)) continue;
    if (typeof entry.data.message === 'string') messages.push(entry.data.message);
  }
  return messages;
}

function currentTaskConflicts(
  events: readonly SessionLogEventEntry[],
): readonly SessionLogEventEntry[] {
  return events.filter((entry) => {
    if (entry.type !== 'paused_external_changes' || !isRecord(entry.data)) return false;
    const conflict = entry.data.conflict;
    return isRecord(conflict) && conflict.kind === 'current-task-conflict';
  });
}

function expectFinishedPlainRun(stdout: string): void {
  assertPlainStdout(stdout, { mode: 'quick' });
  const lines = stdout.split('\n').map((line) => line.trim());
  expect(lines).toContain('task T001: done (no gates)');
  expect(lines).toContain('review: passed');
  expect(lines).toContain('done: 1 tasks');
}

describe('stop → continue → finish', () => {
  it('parks a brief cut by SIGINT and continues it to a passing review', async () => {
    fixture = createStopContinueFixture();
    const target = fixture;

    const parked = await startAndSignal(target, 'SIGINT');
    expect(parked.exitCode).toBe(0);

    const parkedState = readState(target, parked.sessionId);
    expect(parkedState.interruptedStep?.cut).toBe('mid-step');
    expect(parkedState.tasks[0]?.status).toBe('in_progress');
    expect(parkedState.pendingRecovery).toBeUndefined();
    const parkedAttempt = parkedState.attempt;
    expect(existsSync(target.greetPath)).toBe(false);

    const resumed = await continueRun(target);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    expectFinishedPlainRun(resumed.stdout);

    const finalState = readState(target, parked.sessionId);
    expect(finalState.tasks[0]?.status).toBe('done');
    expect(finalState.attempt).toBe(parkedAttempt);
    expect(finalState.pendingRecovery).toBeUndefined();

    const events = readEvents(target, parked.sessionId);
    expect(currentTaskConflicts(events)).toHaveLength(0);
    // The brief runs in the isolation worktree, so its cut partial never reaches the project and
    // there is no own output there to keep. A resumable park continues the same attempt in the
    // same worktree: the marker it left stands, and nothing is discarded or asked about.
    expect(warningsWithCode(events, 'own_partial_output_kept')).toHaveLength(0);
    expect(warningMessages(events).filter((message) => message.startsWith('Discarded'))).toEqual(
      [],
    );

    expect(readFileSync(target.greetPath, 'utf-8')).toBe(GREET_SOURCE);
  });

  it('restarts a brief killed by SIGKILL from its task-start snapshot', async () => {
    fixture = createStopContinueFixture();
    const target = fixture;

    const killed = await startAndSignal(target, 'SIGKILL');
    expect(killed.exitCode).toBeNull();

    const killedState = readState(target, killed.sessionId);
    expect(killedState.interruptedStep).toBeUndefined();
    expect(killedState.tasks[0]?.status).toBe('in_progress');

    const resumed = await continueRun(target);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    expectFinishedPlainRun(resumed.stdout);

    const events = readEvents(target, killed.sessionId);
    expect(warningMessages(events)).toContainEqual(
      `Discarded 1 unpromoted change(s) an earlier attempt left in the isolation worktree: ${MARKER_FILE}`,
    );
    expect(warningsWithCode(events, 'own_partial_output_kept')).toHaveLength(0);

    const finalState = readState(target, killed.sessionId);
    expect(finalState.tasks[0]?.status).toBe('done');
    expect(readFileSync(target.greetPath, 'utf-8')).toBe(GREET_SOURCE);
  });
});
