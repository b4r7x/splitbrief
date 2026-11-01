import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadState } from '../../../src/core/state/persistence.js';
import type { SessionRef } from '../../../src/core/types/session-ref.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { feedbackStore } from '../../../src/stores/ui/feedback.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { flushEffects, type renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { openHaltedRun, settleOpenedRuns } from '../helpers/halted-run-screen.js';
import {
  cli,
  createStopContinueFixture,
  GREET_FILE,
  MARKER_FILE,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const DIAGNOSIS = 'The greeting needs a locale service that the project does not have.';
const REASON = 'No locale service exists in this repository.';

/** Writes nothing, so every attempt fails the brief's checks. */
function idleImplementerScript(): string {
  return `for await (const chunk of process.stdin) void chunk;
console.log('Nothing to change');
`;
}

const GREET_AT_START = 'export const greet = "as it was";\n';

/**
 * Changes one file of the brief, adds another, counts its call and reports itself blocked: a blocked
 * report goes to the planner with no retry.
 */
function writingImplementerScript(callsPath: string): string {
  return `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
appendFileSync(${JSON.stringify(callsPath)}, 'implement\\n');
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(GREET_FILE)}, 'export const greet = "half done";\\n');
writeFileSync(${JSON.stringify(MARKER_FILE)}, 'export const RUN_MARKER = "half done";\\n');
process.stdout.write(${JSON.stringify(JSON.stringify({ status: 'blocked', question: 'Which locale service?', filesNeeded: [] }))});
`;
}

function cannotAnswer(next: 'skip-brief' | 'end-run'): string {
  return JSON.stringify({
    answer: { diagnosis: DIAGNOSIS, action: 'cannot', reason: REASON, next },
  });
}

/** The planner answers every consult on the failing brief that it cannot be done. */
function cannotConsult(next: 'skip-brief' | 'end-run'): string {
  return `(prompt) => {
  const heading = prompt.split('\\n').find((line) => line.startsWith('# '));
  return heading === '# Consult on a failing task' || heading === '# Consult continued'
    ? ${JSON.stringify(cannotAnswer(next))}
    : undefined;
}`;
}

async function selectedActions(ref: SessionRef): Promise<string[]> {
  const { events } = await readRunEvents(ref);
  return events.flatMap((event) =>
    event.type === 'recovery_action_selected' ? [event.action] : [],
  );
}

let fixture: StopContinueFixture | undefined;
let ui: ReturnType<typeof renderFeature> | undefined;

beforeEach(() => resetAllStores());

afterEach(async () => {
  ui?.unmount();
  ui = undefined;
  await settleOpenedRuns();
  resetAllStores();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

describe('e2e: the planner says a brief cannot be done', () => {
  it('halts the run and shows the cannot answer, the headline and the reason on the run screen', async () => {
    fixture = createStopContinueFixture(idleImplementerScript, {
      consult: () => cannotConsult('skip-brief'),
    });
    const halted = await cli(fixture, ['start', 'smoke']);
    expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);

    const opened = await openHaltedRun(fixture, { heading: 'Needs you' });
    ui = opened.screen;
    const frame = stripAnsiStyles(opened.screen.lastFrame());

    expect(frame).toContain(`T001: cannot be done · ${DIAGNOSIS}`);
    expect(frame).toContain('T001: the planner says it cannot be done');
    expect(frame).toContain(`Planner said: ${REASON}`);
    for (const row of ['Try again', 'Decide for me', 'Skip task', 'End run']) {
      expect(frame).toContain(row);
    }

    const stderr = halted.stderr.split('\n');
    const haltLine = stderr.findIndex((line) => line.startsWith('Error: Needs you'));
    expect(stderr[haltLine + 1]).toBe(`Planner said: ${REASON}`);
    expect(frame).toMatch(/Skip task\s+recommended/);
    expect(frame).not.toMatch(/Try again\s+recommended/);
    expect(stderr).toContain('Recommended: skip-current-task');
    expect(halted.stderr).toContain(' --action skip');
    expect(halted.stderr).not.toContain('--action retry');
  });

  it.each([
    ['end-run', 'end-run'],
    ['skip-brief', 'skip-current-task'],
  ] as const)(
    'runs no action on an empty Enter in the composer of a %s halt',
    async (next, recommended) => {
      fixture = createStopContinueFixture(idleImplementerScript, {
        consult: () => cannotConsult(next),
      });
      const halted = await cli(fixture, ['start', 'smoke']);
      expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);
      const { screen, ref } = await openHaltedRun(fixture, { heading: 'Needs you' });
      ui = screen;

      screen.stdin.write('\t');
      await flushEffects();
      screen.stdin.write('\r');
      await vi.waitFor(() =>
        expect(feedbackStore.get().message).toBe('Nothing to send. Tab to choose an action.'),
      );
      expect(stripAnsiStyles(screen.lastFrame())).toContain('tab back to the actions');

      screen.stdin.write('\r');
      await flushEffects();
      expect(stripAnsiStyles(screen.lastFrame())).toContain('tab back to the actions');
      expect(await selectedActions(ref)).toEqual([]);

      screen.stdin.write('\t');
      await flushEffects();
      screen.stdin.write('\r');
      await vi.waitFor(async () => expect(await selectedActions(ref)).toEqual([recommended]));
    },
  );

  it('makes no other implementer call and takes the files of the brief back', async () => {
    fixture = createStopContinueFixture(
      (projectDir) => writingImplementerScript(join(dirname(projectDir), 'implementer-calls')),
      { consult: () => cannotConsult('skip-brief') },
    );
    const greetPath = join(fixture.projectDir, GREET_FILE);
    mkdirSync(dirname(greetPath), { recursive: true });
    writeFileSync(greetPath, GREET_AT_START);
    execFileSync('git', ['add', GREET_FILE], { cwd: fixture.projectDir });
    execFileSync('git', ['commit', '--quiet', '-m', 'add greet'], { cwd: fixture.projectDir });

    const halted = await cli(fixture, ['start', 'smoke']);
    expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);

    expect(readFileSync(join(fixture.tmpDir, 'implementer-calls'), 'utf8')).toBe('implement\n');
    const opened = await openHaltedRun(fixture, { heading: 'Needs you' });
    ui = opened.screen;
    const state = loadState(opened.ref);
    expect(state?.pendingRecovery?.reason).toBe('retry-exhausted');
    const workspace = state?.workspace?.path;
    if (workspace === undefined) throw new Error('the halted run has no workspace');
    expect(readFileSync(join(workspace, GREET_FILE), 'utf8')).toBe(GREET_AT_START);
    expect(existsSync(join(workspace, MARKER_FILE))).toBe(false);
  });
});
