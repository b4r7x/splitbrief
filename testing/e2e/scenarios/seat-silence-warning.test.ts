import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import {
  UI_IDLE_WARN_MS,
  deriveBuildProgress,
  runnerSilenceMs,
} from '../../../src/features/workflow/display/build-progress.js';
import { addEvent } from '../../../src/stores/workflow/actions/event.js';
import { lifecycleStore } from '../../../src/stores/workflow/lifecycle.js';
import { operationsStore } from '../../../src/stores/workflow/operations/state.js';
import { tasksStore } from '../../../src/stores/workflow/tasks.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
  cli,
  createStopContinueFixture,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

/** The seat's own warn threshold: short, so the watchdog warns inside a quiet of a few seconds. */
const IDLE_WARN_MS = 1_000;

/** How long the implementer stays quiet if the test never releases it; a backstop, not a pace. */
const QUIET_HOLD_MS = 120_000;

const RUN_TIMEOUT_MS = 180_000;
const QUIET_WAIT_MS = 90_000;
const STALL_WAIT_MS = 30_000;

type StalledEvent = Extract<EngineEvent, { type: 'runner_call_stalled' }>;

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;
let pendingRun: ReturnType<typeof cli> | undefined;

beforeEach(() => resetAllStores());

afterEach(async () => {
  if (fixture !== undefined) writeFileSync(releasePath(fixture), '');
  await pendingRun;
  resetAllStores();
  restorePath?.();
  vi.unstubAllEnvs();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
  pendingRun = undefined;
});

function releasePath(target: StopContinueFixture): string {
  return join(target.tmpDir, 'release-quiet');
}

function quietPath(target: StopContinueFixture): string {
  return join(target.tmpDir, 'implementer-quiet');
}

function invocationsPath(target: StopContinueFixture): string {
  return join(target.tmpDir, 'implementer-invocations');
}

/**
 * Speaks once, then goes quiet until the test releases it, then speaks again and finishes. The
 * quiet marker carries the moment the first word was written, so the test can tell the stall of
 * this quiet from one a slow process start may cause before the first word.
 */
function quietImplementerScript(target: StopContinueFixture): string {
  return `import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

for await (const chunk of process.stdin) void chunk;
appendFileSync(${JSON.stringify(invocationsPath(target))}, 'call\\n');

mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
process.stdout.write('Wrote the marker\\n');
writeFileSync(${JSON.stringify(quietPath(target))}, String(Date.now()));

const release = ${JSON.stringify(releasePath(target))};
const deadline = Date.now() + ${QUIET_HOLD_MS};
while (!existsSync(release) && Date.now() < deadline) await delay(50);

process.stdout.write('Writing the greeting\\n');
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
`;
}

async function waitForQuietStart(target: StopContinueFixture): Promise<number> {
  const deadline = Date.now() + QUIET_WAIT_MS;
  while (Date.now() < deadline) {
    if (existsSync(quietPath(target))) {
      const text = readFileSync(quietPath(target), 'utf8');
      if (text !== '') return Number(text);
    }
    await delay(50);
  }
  throw new Error(`the implementer never went quiet within ${QUIET_WAIT_MS}ms`);
}

/** Polls the run's own log for the watchdog's warn on the quiet stretch of the implementer call. */
async function waitForQuietStall(
  target: StopContinueFixture,
  quietSince: number,
): Promise<{ stalled: StalledEvent; sessionId: string }> {
  const deadline = Date.now() + STALL_WAIT_MS;
  while (Date.now() < deadline) {
    const sessionId = readActive(target.projectDir);
    if (sessionId !== null) {
      const { events } = await readRunEvents({ projectDir: target.projectDir, sessionId });
      const stalled = quietStall(events, quietSince);
      if (stalled !== undefined) return { stalled, sessionId };
    }
    await delay(100);
  }
  throw new Error(`the watchdog never warned on the quiet implementer within ${STALL_WAIT_MS}ms`);
}

// The warn of the quiet stretch fires a full idleWarnMs after the last word; a warn before the
// first word lands earlier, so half the threshold past the quiet marker separates the two.
function quietStall(events: readonly EngineEvent[], quietSince: number): StalledEvent | undefined {
  return events.find(
    (event): event is StalledEvent =>
      event.type === 'runner_call_stalled' &&
      event.role === 'implementer' &&
      event.ts >= quietSince + IDLE_WARN_MS / 2,
  );
}

function progressAt(now: number) {
  return deriveBuildProgress({
    tasks: tasksStore.get(),
    lifecycle: lifecycleStore.get(),
    operations: operationsStore.get(),
    now,
  });
}

describe('e2e: seat silence warning', { timeout: 240_000 }, () => {
  it('warns on a silent implementer call, never ends it, and clears the warning when output returns', async () => {
    fixture = createStopContinueFixture(() => '', { isolation: 'none' });
    const target = fixture;
    restorePath = activateSafeCliShimPath(target.tmpDir);
    const offlinePath = join(target.tmpDir, 'offline.mjs');
    writeFileSync(
      offlinePath,
      "globalThis.fetch = async () => { throw new Error('E2E network disabled'); };\n",
    );
    vi.stubEnv('NODE_OPTIONS', `--import=${offlinePath}`);
    const implementerPath = join(target.tmpDir, 'implementer.mjs');
    writeFileSync(implementerPath, quietImplementerScript(target));

    const config = loadConfig(target.projectDir).config;
    if (config.implementer.kind !== 'agent') {
      throw new Error('Expected the local agent fixture implementer');
    }
    // The seat carries no total deadline and no idle cut: the silence can only warn.
    expect(config.implementer.timeout).toBeUndefined();
    expect(config.implementer.idleKillMs).toBeUndefined();
    writeConfig(target.projectDir, {
      ...config,
      implementer: { ...config.implementer, args: [implementerPath], idleWarnMs: IDLE_WARN_MS },
    });

    pendingRun = cli(target, ['start', 'smoke'], { timeoutMs: RUN_TIMEOUT_MS });
    const quietSince = await waitForQuietStart(target);
    // A finished run clears the active pointer, so the run is named while it is still going.
    const { stalled, sessionId } = await waitForQuietStall(target, quietSince);
    expect(stalled.silentMs).toBeGreaterThanOrEqual(IDLE_WARN_MS);
    expect(existsSync(join(target.projectDir, GREET_FILE))).toBe(false);
    writeFileSync(releasePath(target), '');

    const run = await pendingRun;
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
    const state = readState(target, sessionId);
    expect(state.phase).toBe('complete');
    expect(state.tasks.map((task) => ({ id: task.id, status: task.status }))).toEqual([
      { id: 'T001', status: 'done' },
    ]);
    expect(readFileSync(join(target.projectDir, GREET_FILE), 'utf8')).toBe(GREET_SOURCE);
    expect(readFileSync(invocationsPath(target), 'utf8')).toBe('call\n');

    const replay = await readRunEvents({ projectDir: target.projectDir, sessionId });
    expect(replay.diagnostics.skipped).toBe(0);
    const events = replay.events;
    const callId = stalled.callId;
    const implementerStarts = events.filter(
      (event) => event.type === 'runner_call_started' && event.role === 'implementer',
    );
    expect(implementerStarts).toHaveLength(1);
    expect(implementerStarts[0]).toMatchObject({ callId, taskId: 'T001', backendKind: 'agent' });
    expect(events.some((event) => event.type === 'runner_call_error')).toBe(false);
    const startedIndex = events.findIndex(
      (event) => event.type === 'runner_call_started' && event.callId === callId,
    );
    const stalledIndex = events.findIndex(
      (event) =>
        event.type === 'runner_call_stalled' && event.callId === callId && event.ts === stalled.ts,
    );
    const clearedIndex = events.findIndex(
      (event, index) =>
        index > stalledIndex &&
        event.type === 'runner_call_stall_cleared' &&
        event.callId === callId,
    );
    const completedIndex = events.findIndex(
      (event) => event.type === 'runner_call_completed' && event.callId === callId,
    );
    expect(startedIndex).toBeGreaterThan(-1);
    expect(stalledIndex).toBeGreaterThan(startedIndex);
    expect(clearedIndex).toBeGreaterThan(stalledIndex);
    expect(completedIndex).toBeGreaterThan(clearedIndex);
    expect(events[completedIndex]).toMatchObject({ status: 'completed' });
    expect(events.some((event) => event.type === 'workflow_complete')).toBe(true);

    for (const event of events.slice(0, stalledIndex + 1)) addEvent(event);
    expect(lifecycleStore.get().phase).toBe('implementing');
    expect(operationsStore.get().active).toMatchObject({ callId, role: 'implementer' });
    expect(lifecycleStore.get().stall).toMatchObject({ since: stalled.ts });

    const warnAt = stalled.ts + 75_000 - stalled.silentMs;
    expect(runnerSilenceMs(lifecycleStore.get(), warnAt)).toBe(75_000);
    const silent = progressAt(warnAt);
    expect(silent.silent).toBe(true);
    expect(silent.freshness).toBe('No output for 1:15');
    expect(silent.activity).toContain('working on T001');

    const belowFloor = progressAt(stalled.ts + UI_IDLE_WARN_MS - 1_000 - stalled.silentMs);
    expect(belowFloor.silent).toBe(false);
    expect(belowFloor.freshness).toMatch(/^last event /);

    for (const event of events.slice(stalledIndex + 1, clearedIndex + 1)) addEvent(event);
    expect(lifecycleStore.get().stall).toBeNull();
    expect(operationsStore.get().active).toMatchObject({ callId, role: 'implementer' });
    const recovered = progressAt(warnAt);
    expect(recovered.silent).toBe(false);
    expect(recovered.freshness).not.toContain('No output for');
  });
});
