import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  cli,
  continueAndSignal,
  continueRun,
  continueWithCorrection,
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

/** What one implementer invocation does: the files it writes, then whether it holds for a stop. */
type ImplementerCall = Readonly<{ writes?: Readonly<Record<string, string>>; holds?: true }>;

const BOTH_FILES = { [GREET_FILE]: GREET_SOURCE, [MARKER_FILE]: MARKER_SOURCE };

/** A greet the corrected call writes over the kept one. */
const TRIMMED_GREET_SOURCE = `export function greet(name: string): string {
  const trimmed = name.trim();
  return trimmed === '' ? 'hello' : \`hello \${trimmed}\`;
}`;

/**
 * Invocation n does `calls[n]`: it saves its prompt, writes its files and, when it holds, signals
 * under `signal/<n>/` (outside the project, so a call that writes nothing can be stopped too) and
 * waits for the stop. An invocation past the list is a retry: it writes both files.
 */
function implementerCalls(calls: readonly ImplementerCall[]): (projectDir: string) => string {
  return (projectDir) => {
    const tmpDir = join(projectDir, '..');
    return `import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

const countPath = ${JSON.stringify(join(tmpDir, 'implementer-invocations'))};
let invocations = 0;
try {
  invocations = Number(readFileSync(countPath, 'utf8')) || 0;
} catch {}
writeFileSync(countPath, String(invocations + 1));
writeFileSync(join(${JSON.stringify(tmpDir)}, 'prompt-' + invocations), Buffer.concat(chunks));

const call = ${JSON.stringify(calls)}[invocations] ?? { writes: ${JSON.stringify(BOTH_FILES)} };
for (const [file, text] of Object.entries(call.writes ?? {})) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}
if (call.holds) {
  writeFileSync(${JSON.stringify(join(tmpDir, 'implementer-hold.pid'))}, String(process.pid));
  const signalPath = join(${JSON.stringify(join(tmpDir, 'signal'))}, String(invocations), ${JSON.stringify(MARKER_FILE)});
  mkdirSync(dirname(signalPath), { recursive: true });
  writeFileSync(signalPath, '');
  const deadline = Date.now() + 180000;
  while (!existsSync(${JSON.stringify(join(tmpDir, 'release-implementer'))}) && Date.now() < deadline) await delay(50);
  writeFileSync(${JSON.stringify(join(tmpDir, 'implementer-hold-exited'))}, '');
}
`;
  };
}

/** Where invocation n signals that it holds. */
function signalDir(target: StopContinueFixture, invocation: number): string {
  return join(target.tmpDir, 'signal', String(invocation));
}

function invocations(target: StopContinueFixture): number {
  return Number(readFileSync(join(target.tmpDir, 'implementer-invocations'), 'utf8'));
}

function prompt(target: StopContinueFixture, invocation: number): string {
  return readFileSync(join(target.tmpDir, `prompt-${invocation}`), 'utf8');
}

async function retries(target: StopContinueFixture, sessionId: string): Promise<string[]> {
  const { events } = await readRunEvents({ projectDir: target.projectDir, sessionId });
  return events.flatMap((event) => (event.type === 'task_retry' ? [event.error] : []));
}

/** Ends the run from the shell and returns the patch it saved. */
async function endRunPatch(target: StopContinueFixture, sessionId: string): Promise<string> {
  const ended = await cli(target, ['continue', sessionId, '--action', 'end-run']);
  expect(ended.exitCode, ended.stderr).toBe(0);
  const closed = readState(target, sessionId).closed;
  if (closed?.patch === undefined) throw new Error('the ended run has no patch');
  return readFileSync(join(target.projectDir, closed.patch), 'utf8');
}

const KEPT_GREET = '+export function greet(name: string): string {';
const KEPT_MARKER = "+export const RUN_MARKER = 'implementer-started';";

describe('stop after the brief wrote its files → continue', { timeout: 240_000 }, () => {
  it('passes the brief on the kept work when the resumed call changes nothing', async () => {
    fixture = createStopContinueFixture(
      implementerCalls([{ writes: BOTH_FILES, holds: true }, {}]),
    );
    const target = fixture;

    const parked = await startAndSignal(target, 'SIGINT', signalDir(target, 0));
    expect(parked.exitCode).toBe(0);

    const resumed = await continueRun(target);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    expect(resumed.stdout).toContain('task T001: done (no checks)');
    expect(invocations(target)).toBe(2);
    expect(await retries(target, parked.sessionId)).toEqual([]);

    const patch = await endRunPatch(target, parked.sessionId);
    expect(patch).toContain(KEPT_GREET);
    expect(patch).toContain(KEPT_MARKER);
  });

  it('passes the brief on the kept work when a typed correction needs no change', async () => {
    fixture = createStopContinueFixture(
      implementerCalls([{ writes: BOTH_FILES, holds: true }, {}]),
    );
    const target = fixture;
    const correction = 'The two files look right. Keep them as they are.';

    const parked = await startAndSignal(target, 'SIGINT', signalDir(target, 0));
    expect(parked.exitCode).toBe(0);

    const resumed = await continueWithCorrection(target, parked.sessionId, correction);
    expect(resumed.tasks).toMatchObject([{ id: 'T001', status: 'done' }]);
    expect(invocations(target)).toBe(2);
    expect(prompt(target, 1)).toContain(correction);
    expect(await retries(target, parked.sessionId)).toEqual([]);

    const patch = await endRunPatch(target, parked.sessionId);
    expect(patch).toContain(KEPT_GREET);
    expect(patch).toContain(KEPT_MARKER);
  });

  it('keeps the work a typed correction changes on resume', async () => {
    fixture = createStopContinueFixture(
      implementerCalls([
        { writes: BOTH_FILES, holds: true },
        { writes: { [GREET_FILE]: TRIMMED_GREET_SOURCE } },
      ]),
    );
    const target = fixture;
    const correction = 'Trim the name before the greeting.';

    const parked = await startAndSignal(target, 'SIGINT', signalDir(target, 0));
    expect(parked.exitCode).toBe(0);

    const resumed = await continueWithCorrection(target, parked.sessionId, correction);
    expect(resumed.tasks).toMatchObject([{ id: 'T001', status: 'done' }]);
    expect(invocations(target)).toBe(2);
    expect(prompt(target, 1)).toContain(correction);
    expect(await retries(target, parked.sessionId)).toEqual([]);

    const patch = await endRunPatch(target, parked.sessionId);
    expect(patch).toContain('+  const trimmed = name.trim();');
    expect(patch).toContain(KEPT_MARKER);
  });

  it('keeps the work across a second stop and continue', async () => {
    fixture = createStopContinueFixture(
      implementerCalls([{ writes: BOTH_FILES, holds: true }, { holds: true }, {}]),
    );
    const target = fixture;

    const parked = await startAndSignal(target, 'SIGINT', signalDir(target, 0));
    expect(parked.exitCode).toBe(0);
    const parkedAgain = await continueAndSignal(target, 'SIGINT', signalDir(target, 1));
    expect(parkedAgain.exitCode).toBe(0);
    expect(parkedAgain.sessionId).toBe(parked.sessionId);
    expect(readState(target, parked.sessionId).interruptedStep?.cut).toBe('mid-step');

    const resumed = await continueRun(target);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    expect(resumed.stdout).toContain('task T001: done (no checks)');
    expect(invocations(target)).toBe(3);
    expect(await retries(target, parked.sessionId)).toEqual([]);

    const patch = await endRunPatch(target, parked.sessionId);
    expect(patch).toContain(KEPT_GREET);
    expect(patch).toContain(KEPT_MARKER);
  });

  it('keeps the first file when the stop came before the second', async () => {
    fixture = createStopContinueFixture(
      implementerCalls([
        { writes: { [MARKER_FILE]: MARKER_SOURCE }, holds: true },
        { writes: { [GREET_FILE]: GREET_SOURCE } },
      ]),
    );
    const target = fixture;

    const parked = await startAndSignal(target, 'SIGINT', signalDir(target, 0));
    expect(parked.exitCode).toBe(0);

    const resumed = await continueRun(target);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    expect(resumed.stdout).toContain('task T001: done (no checks)');
    expect(invocations(target)).toBe(2);
    expect(await retries(target, parked.sessionId)).toEqual([]);

    const patch = await endRunPatch(target, parked.sessionId);
    expect(patch).toContain(KEPT_GREET);
    expect(patch).toContain(KEPT_MARKER);
  });

  it('still retries a resumed brief that has no change at all', async () => {
    fixture = createStopContinueFixture(implementerCalls([{ holds: true }, {}]));
    const target = fixture;

    const parked = await startAndSignal(target, 'SIGINT', signalDir(target, 0));
    expect(parked.exitCode).toBe(0);

    const resumed = await continueRun(target);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    expect(resumed.stdout).toContain('task T001: done (no checks)');
    expect(invocations(target)).toBe(3);
    expect(await retries(target, parked.sessionId)).toHaveLength(1);
  });
});
