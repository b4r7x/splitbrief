import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalizeProjectDir } from '../../../src/cli/setup.js';
import type { RecoveryIssue } from '../../../src/core/schemas/recovery/schemas.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { resumeStep } from '../../../src/core/sessions/run-status.js';
import { loadState, saveState } from '../../../src/core/state/persistence.js';
import type { SessionRef } from '../../../src/core/types/session-ref.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { publishRecoveryPrompted } from '../../../src/engine/orchestrator/events.js';
import { createRecoveryBus } from '../../../src/engine/orchestrator/recovery/bus.js';
import { addTuiEvent } from '../../../src/features/workflow/tui-sink.js';
import { runViewStore } from '../../../src/stores/workflow/run-view.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { flushEffects, type renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { openHaltedRun, settleOpenedRuns } from '../helpers/halted-run-screen.js';
import {
  cli,
  createStopContinueFixture,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

/** Enough paths to pass the bound of an event on the run screen. */
const MANY_FILES = Array.from(
  { length: 7000 },
  (_, index) => `src/generated/module-${String(index).padStart(5, '0')}/index.ts`,
);

const QUESTION = 'Which file holds the locales?';

/** Writes nothing and reports itself blocked on the question, on every attempt. */
function blockedImplementerScript(): string {
  return `for await (const chunk of process.stdin) void chunk;
process.stdout.write(${JSON.stringify(JSON.stringify({ status: 'blocked', question: QUESTION, filesNeeded: [] }))});
`;
}

const ASK_USER = JSON.stringify({
  answer: {
    diagnosis: 'The implementer is blocked on the locale source.',
    action: 'ask-user',
    question: QUESTION,
    whyOnlyUserCanAnswer: 'Only you know which file holds the locales.',
    choices: null,
    default: null,
  },
});

function askingConsult(): string {
  return `(prompt) => {
  const heading = prompt.split('\\n').find((line) => line.startsWith('# '));
  return heading === '# Consult on a failing task' || heading === '# Consult continued'
    ? ${JSON.stringify(ASK_USER)}
    : undefined;
}`;
}

/** The engine entry halts again on an issue whose prompt event is too large for the screen. */
function haltOnManyFiles(ref: SessionRef, first: RecoveryIssue): void {
  const state = loadState(ref);
  if (state === null) throw new Error('The run saved no state');
  const issue: RecoveryIssue = { ...first, id: 'rec_many_files', files: MANY_FILES };
  saveState(ref, { ...state, pendingRecovery: issue });
  publishRecoveryPrompted(
    { bus: createRecoveryBus({ ...ref, sink: addTuiEvent }), phase: state.phase },
    ref.sessionId,
    issue,
    resumeStep(state),
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
  vi.unstubAllEnvs();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

describe('e2e: a halt too large for its event', () => {
  it('opens the recovery panel, and a row of it acts', async () => {
    fixture = createStopContinueFixture(blockedImplementerScript, { consult: askingConsult });
    const halted = await cli(fixture, ['start', 'smoke']);
    expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);
    const engine: { halt?: () => void } = {};
    const { screen, ref, state } = await openHaltedRun(fixture, {
      heading: 'Needs you',
      runWorkflow: async () => {
        engine.halt?.();
        return makeSummary();
      },
    });
    ui = screen;
    const first = state.pendingRecovery;
    if (first === undefined) throw new Error('The run saved no halt');
    engine.halt = () => haltOnManyFiles(ref, first);

    screen.stdin.write('r');

    await vi.waitFor(() => expect(runViewStore.get().halt?.issue.id).toBe('rec_many_files'));
    await vi.waitFor(() => {
      const frame = stripAnsiStyles(screen.lastFrame());
      expect(frame).toContain('End run');
      expect(frame).toContain('confirm');
    });
    await flushEffects();

    screen.stdin.write('a');

    await vi.waitFor(async () => {
      const { events } = await readRunEvents(ref);
      expect(
        events.flatMap((event) =>
          event.type === 'recovery_action_selected' ? [event.action] : [],
        ),
      ).toEqual(['retry-same-worker', 'end-run']);
    });
  });

  it('keeps the halt in the `continue --json` record and leaves out its files', async () => {
    fixture = createStopContinueFixture(blockedImplementerScript, { consult: askingConsult });
    const halted = await cli(fixture, ['start', 'smoke']);
    expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);
    const projectDir = await canonicalizeProjectDir({ project: fixture.projectDir });
    const sessionId = readActive(projectDir);
    if (sessionId === null) throw new Error('The halted run saved no session');
    const ref = { projectDir, sessionId };
    const state = loadState(ref);
    const first = state?.pendingRecovery;
    if (state === null || first === undefined) throw new Error('The run saved no halt');
    saveState(ref, { ...state, pendingRecovery: { ...first, files: MANY_FILES } });

    const resumed = await cli(fixture, ['continue', sessionId], { json: true, timeoutMs: 60_000 });

    expect(resumed.exitCode, `${resumed.stdout}\n${resumed.stderr}`).toBe(1);
    const halt = resumed.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string })
      .find((record) => record.type === 'recovery_required');
    expect(halt).toMatchObject({
      sessionId,
      reason: first.reason,
      availableActions: first.availableActions,
      recommendedAction: first.recommendedAction,
      resumeCommand: expect.stringContaining(sessionId),
    });
    expect(halt).not.toHaveProperty('files');
  });
});
