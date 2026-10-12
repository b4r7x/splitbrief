import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readRunRecord } from '../../../src/core/sessions/run-record-io.js';
import { readRunnerPids } from '../../../src/core/sessions/runner-pids.js';
import { readRunHistory } from '../../../src/features/workflow/run-history.js';
import { canSignalProcess } from '../../../src/lib/process/liveness.js';
import { killOrphanRunner, plantOrphanRunner } from '#testing/helpers/orphan-runner.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  cli,
  createStopContinueFixture,
  endImplementerHold,
  findMarker,
  MARKER_FILE,
  MARKER_SOURCE,
  startAndSignal,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

/** The watchdog's SIGTERM-to-SIGKILL grace plus a loaded box's start-up. */
const ORPHAN_EXIT_TIMEOUT_MS = 10_000;

const HEARTBEAT_FILE = 'heartbeat.txt';

/**
 * A tool that will not stop on its own: it ignores SIGHUP and SIGTERM and rewrites a heartbeat
 * beside the marker in the run workspace every 50 ms until the fixture releases it.
 */
function heartbeatImplementerScript(tmpDir: string): string {
  return `import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

for (const signal of ['SIGHUP', 'SIGTERM']) process.on(signal, () => {});
for await (const chunk of process.stdin) void chunk;

writeFileSync(${JSON.stringify(join(tmpDir, 'implementer-hold.pid'))}, String(process.pid));
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
const releasePath = ${JSON.stringify(join(tmpDir, 'release-implementer'))};
for (let beat = 0; !existsSync(releasePath); beat += 1) {
  writeFileSync(${JSON.stringify(`src/${HEARTBEAT_FILE}`)}, String(beat));
  await delay(50);
}
writeFileSync(${JSON.stringify(join(tmpDir, 'implementer-hold-exited'))}, '');
`;
}

let fixture: StopContinueFixture | undefined;
const planted: number[] = [];

afterEach(async () => {
  for (const pid of planted.splice(0)) killOrphanRunner(pid);
  if (fixture !== undefined) {
    await endImplementerHold(fixture);
    cleanupTempDir(fixture.tmpDir);
  }
  fixture = undefined;
});

async function crashMidBuild(): Promise<{ target: StopContinueFixture; sessionId: string }> {
  fixture = createStopContinueFixture((projectDir) =>
    heartbeatImplementerScript(dirname(projectDir)),
  );
  const target = fixture;
  const killed = await startAndSignal(target, 'SIGKILL', target.isolationTreesDir);
  expect(killed.exitCode).toBeNull();
  return { target, sessionId: killed.sessionId };
}

async function expectGone(pid: number, who: string): Promise<void> {
  await vi.waitFor(
    () => expect(canSignalProcess(pid), `${who} ${pid} is still alive`).toBe(false),
    {
      timeout: ORPHAN_EXIT_TIMEOUT_MS,
      interval: 50,
    },
  );
}

describe('a crashed CLI leaves no tool running', { timeout: 240_000 }, () => {
  it('ends a tool that ignores SIGTERM when the CLI is SIGKILLed, and the workspace stops changing', async () => {
    const { target } = await crashMidBuild();
    const marker = findMarker(target.isolationTreesDir);
    if (marker === null) throw new Error(`no ${MARKER_FILE} in the run workspace`);
    const heartbeat = join(dirname(marker), HEARTBEAT_FILE);
    const tool = Number(readFileSync(target.implementerPidPath, 'utf8'));

    await expectGone(tool, 'the implementer');

    const lastBeat = readFileSync(heartbeat, 'utf8');
    await delay(500);
    expect(readFileSync(heartbeat, 'utf8')).toBe(lastBeat);
  });

  it('reaps a tool the crashed CLI left running when the run is opened at rest', async () => {
    const { target, sessionId } = await crashMidBuild();
    const ref = { projectDir: target.projectDir, sessionId };
    const orphan = plantOrphanRunner(ref);
    planted.push(orphan);

    await readRunHistory(readRunRecord(ref));

    expect(canSignalProcess(orphan), `orphan ${orphan} outlived opening the run`).toBe(false);
    expect(readRunnerPids(ref)).toEqual([]);
  });

  it('reaps a tool the crashed CLI left running when the run is ended headless', async () => {
    const { target, sessionId } = await crashMidBuild();
    const ref = { projectDir: target.projectDir, sessionId };
    const orphan = plantOrphanRunner(ref);
    planted.push(orphan);

    const ended = await cli(target, ['continue', sessionId, '--action', 'end-run']);

    expect(ended.exitCode, ended.stderr).toBe(0);
    expect(canSignalProcess(orphan), `orphan ${orphan} outlived End run`).toBe(false);
    expect(readRunnerPids(ref)).toEqual([]);
  });
});
