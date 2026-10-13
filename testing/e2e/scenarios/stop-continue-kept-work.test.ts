import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  cli,
  continueRun,
  createStopContinueFixture,
  endImplementerHold,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
  readState,
  startAndSignal,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

let fixture: StopContinueFixture | undefined;

afterEach(async () => {
  if (fixture !== undefined) {
    await endImplementerHold(fixture);
    cleanupTempDir(fixture.tmpDir);
  }
  fixture = undefined;
});

/** The first call signals here, outside the project, so a call that writes nothing can be stopped too. */
function signalDir(target: StopContinueFixture): string {
  return join(target.tmpDir, 'signal');
}

/**
 * The first call writes the brief's two files (or nothing), signals and holds until the stop.
 * The resumed call finds the work on disk and changes nothing. A later call is a retry and
 * writes both files.
 */
function resumeChangesNothingScript(firstCallWrites: boolean): (projectDir: string) => string {
  return (projectDir) => {
    const tmpDir = join(projectDir, '..');
    const write = `mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});`;
    return `import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

for await (const chunk of process.stdin) void chunk;

const countPath = ${JSON.stringify(join(tmpDir, 'implementer-invocations'))};
let invocations = 0;
try {
  invocations = Number(readFileSync(countPath, 'utf8')) || 0;
} catch {}
writeFileSync(countPath, String(invocations + 1));

if (invocations === 1) process.exit(0);
if (invocations > 1) {
  ${write}
  process.exit(0);
}

writeFileSync(${JSON.stringify(join(tmpDir, 'implementer-hold.pid'))}, String(process.pid));
${firstCallWrites ? write : ''}
const signalPath = ${JSON.stringify(join(tmpDir, 'signal', MARKER_FILE))};
mkdirSync(dirname(signalPath), { recursive: true });
writeFileSync(signalPath, '');
const deadline = Date.now() + 180000;
while (!existsSync(${JSON.stringify(join(tmpDir, 'release-implementer'))}) && Date.now() < deadline) await delay(50);
writeFileSync(${JSON.stringify(join(tmpDir, 'implementer-hold-exited'))}, '');
`;
  };
}

function invocations(target: StopContinueFixture): number {
  return Number(readFileSync(join(target.tmpDir, 'implementer-invocations'), 'utf8'));
}

async function retries(target: StopContinueFixture, sessionId: string): Promise<string[]> {
  const { events } = await readRunEvents({ projectDir: target.projectDir, sessionId });
  return events.flatMap((event) => (event.type === 'task_retry' ? [event.error] : []));
}

describe('stop after the brief wrote its files → continue', { timeout: 240_000 }, () => {
  it('passes the brief on the kept work when the resumed call changes nothing', async () => {
    fixture = createStopContinueFixture(resumeChangesNothingScript(true));
    const target = fixture;

    const parked = await startAndSignal(target, 'SIGINT', signalDir(target));
    expect(parked.exitCode).toBe(0);

    const resumed = await continueRun(target);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    expect(resumed.stdout).toContain('task T001: done (no checks)');
    expect(invocations(target)).toBe(2);
    expect(await retries(target, parked.sessionId)).toEqual([]);

    const ended = await cli(target, ['continue', parked.sessionId, '--action', 'end-run']);
    expect(ended.exitCode, ended.stderr).toBe(0);
    const closed = readState(target, parked.sessionId).closed;
    if (closed?.patch === undefined) throw new Error('the ended run has no patch');
    const patch = readFileSync(join(target.projectDir, closed.patch), 'utf8');
    expect(patch).toContain('+export function greet(name: string): string {');
    expect(patch).toContain("+export const RUN_MARKER = 'implementer-started';");
  });

  it('still retries a resumed brief that has no change at all', async () => {
    fixture = createStopContinueFixture(resumeChangesNothingScript(false));
    const target = fixture;

    const parked = await startAndSignal(target, 'SIGINT', signalDir(target));
    expect(parked.exitCode).toBe(0);

    const resumed = await continueRun(target);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    expect(resumed.stdout).toContain('task T001: done (no checks)');
    expect(invocations(target)).toBe(3);
    expect(await retries(target, parked.sessionId)).toHaveLength(1);
  });
});
