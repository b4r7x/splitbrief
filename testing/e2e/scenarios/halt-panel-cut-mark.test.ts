import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { canonicalizeProjectDir } from '../../../src/cli/setup.js';
import { join } from 'node:path';
import { writeConfig } from '../../../src/core/config/load/io.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { buildRetryExhaustedRecoveryIssue } from '../../../src/engine/orchestrator/recovery/builders/retry.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { readActive, writeActive } from '../../../src/core/sessions/active-pointer.js';
import { taskId } from '../../../src/core/schemas/task.js';
import { loadState, saveState } from '../../../src/core/state/persistence.js';
import { buildReviewFailedRecoveryIssue } from '../../../src/engine/orchestrator/recovery/builders/review-failed.js';
import { conversationScrollStore } from '../../../src/stores/workflow/conversation-scroll.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { flushEffects, type renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { openHaltedRun } from '../helpers/halted-run-screen.js';
import {
  cli,
  createStopContinueFixture,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const QUESTION = `${'greet.ts needs a locale table, but the brief names no locale source. '.repeat(4)}Which file holds the locales?`;

/**
 * The planner's reason on the task-review no-progress halt the visual fixture renders, long enough
 * to outrun every summary budget a short panel holds.
 */
const PLANNER_REASON = `The type test needs a decision on what alpha exports. ${'word '.repeat(70)}alpha-reason-end`;

/** Writes nothing and reports itself blocked on a long question, on every attempt. */
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

/** The headless run halts when the planner asks a question without a default. */
function askingConsult(): string {
  return `(prompt) => {
  const heading = prompt.split('\\n').find((line) => line.startsWith('# '));
  return heading === '# Consult on a failing task' || heading === '# Consult continued'
    ? ${JSON.stringify(ASK_USER)}
    : undefined;
}`;
}

const REASON = 'No locale service exists in this repository.';

const CANNOT = JSON.stringify({
  answer: {
    diagnosis: 'The greeting needs a locale service.',
    action: 'cannot',
    reason: REASON,
    next: 'skip-brief',
  },
});

/** The planner answers the consult that the brief cannot be done. */
function cannotConsult(): string {
  return `(prompt) => {
  const heading = prompt.split('\\n').find((line) => line.startsWith('# '));
  return heading === '# Consult on a failing task' || heading === '# Consult continued'
    ? ${JSON.stringify(CANNOT)}
    : undefined;
}`;
}

let fixture: StopContinueFixture | undefined;
let ui: ReturnType<typeof renderFeature> | undefined;

beforeEach(() => resetAllStores());

afterEach(() => {
  ui?.unmount();
  ui = undefined;
  resetAllStores();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

/** Runs the fixture until nobody answers the planner's question and opens the halt on the run screen. */
async function openConsultHalt() {
  fixture = createStopContinueFixture(blockedImplementerScript, {
    consult: askingConsult,
  });
  const halted = await cli(fixture, ['start', 'smoke']);
  expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);

  const opened = await openHaltedRun(fixture, { heading: 'Needs you' });
  ui = opened.screen;
  return opened;
}

/**
 * The task-review no-progress halt of `workflow-recovery-task-review-no-progress` on a run the CLI
 * left halted. Its only fact is the planner's reason, so the blank row under the headline is the
 * one row the summary can spend on the reason itself.
 */
async function openNoProgressHalt() {
  fixture = createStopContinueFixture(blockedImplementerScript, { consult: askingConsult });
  const halted = await cli(fixture, ['start', 'smoke']);
  expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);

  const projectDir = await canonicalizeProjectDir({ project: fixture.projectDir });
  const sessionId = readActive(projectDir);
  if (sessionId === null) throw new Error('The halted run saved no session');
  const ref = { projectDir, sessionId };
  const state = loadState(ref);
  if (state === null) throw new Error('The halted run saved no state');
  saveState(ref, {
    ...state,
    pendingRecovery: buildReviewFailedRecoveryIssue({
      id: 'rec_no_progress_replay',
      blocking: 1,
      noProgress: ['F1'],
      fixCycle: 2,
      cannot: PLANNER_REASON,
      phase: 'implementing',
      scope: 'task',
      afterTaskId: taskId('T002'),
      createdAt: '2026-09-24T00:00:00.000Z',
    }),
  });

  const opened = await openHaltedRun(fixture, { heading: 'Needs you' });
  ui = opened.screen;
  return opened;
}

/** Reopens a saved question with the CLI state reader and the workflow screen. */
async function openSavedConsultHalt() {
  const projectDir = createTempDir('halt-question-replay');
  onTestFinished(() => cleanupTempDir(projectDir));
  const ref = { projectDir, sessionId: 'saved-halt' };
  const task = makeTask({ id: 'T001', title: 'Read a stored stop' });
  const issue = buildRetryExhaustedRecoveryIssue({
    id: 'rec-question',
    task,
    phase: 'implementing',
    attempts: 3,
    question: QUESTION,
    allowRetryOverride: true,
    createdAt: '2026-10-11T00:00:00.000Z',
  });
  writeConfig(projectDir, makeConfig());
  saveState(ref, {
    ...createInitialState(task.title),
    phase: 'implementing',
    tasks: [task],
    pendingRecovery: issue,
  });
  writeActive(ref);
  const target = { projectDir, stateHome: join(projectDir, 'state') };
  const status = await cli(target, ['status']);
  expect(status.exitCode, status.stderr).toBe(0);
  const opened = await openHaltedRun(target, { heading: 'Needs you' });
  ui = opened.screen;
  return opened;
}

describe('e2e: a halt panel too short for its text', () => {
  it('shows the whole question, marks the cut lines at 80x24, and keeps the actions and the legend', async () => {
    const opened = await openConsultHalt();
    expect(opened.state.pendingRecovery).toMatchObject({
      reason: 'retry-exhausted',
      details: expect.arrayContaining([`Question: ${QUESTION}`]),
    });

    const wide = stripAnsiStyles(opened.screen.lastFrame());
    expect(wide).toContain('Which file holds the locales?');
    expect(wide).not.toContain('...');

    terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: true });
    await flushEffects();
    const frame = stripAnsiStyles(opened.screen.lastFrame());

    expect(frame).toMatch(/… \d+ more lines/);
    expect(frame).toContain('Skip brief');
    expect(frame).toContain('End run');
    expect(frame).toContain('↑↓ select · ⏎ confirm');
  });

  it.each([
    [60, 18],
    [80, 24],
    [100, 20],
    [140, 16],
    [140, 17],
    [80, 16],
  ])(
    'reopens the saved halt with the whole question as the actions scroll at %dx%d',
    async (cols, rows) => {
      const opened = await openSavedConsultHalt();
      terminalSizeStore.__testReset({ cols, rows, isSmall: true });
      await flushEffects();
      for (const action of ['Try again', 'Decide for me', 'Skip brief', 'End run']) {
        const frame = stripAnsiStyles(opened.screen.lastFrame());
        expect(frame.replace(/[│|\s]/gu, '')).toContain(QUESTION.replace(/\s/gu, ''));
        expect(frame).toContain(action);
        opened.screen.stdin.write('\u001b[B');
        await flushEffects();
      }
    },
  );

  it('keeps the task and its files under the long question at 80x24', async () => {
    const opened = await openConsultHalt();

    terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: true });
    await flushEffects();
    const frame = stripAnsiStyles(opened.screen.lastFrame());

    const question = frame.indexOf('Question: greet.ts needs');
    expect(question).toBeGreaterThan(-1);
    expect(question).toBeLessThan(frame.indexOf('Brief T001'));
    expect(frame).toContain('Files src/greet.ts');
  });

  it('keeps the cut planner reason above the task review actions at 60x18', async () => {
    const opened = await openNoProgressHalt();
    expect(opened.state.pendingRecovery).toMatchObject({
      reason: 'review-failed',
      details: [`Planner said: ${PLANNER_REASON}`],
    });

    terminalSizeStore.__testReset({ cols: 60, rows: 18, isSmall: true });
    await flushEffects();
    const rows = stripAnsiStyles(opened.screen.lastFrame()).split('\n');

    const headline = rows.findLastIndex((row) =>
      row.includes('Needs you · Review T002 made no progress on F1'),
    );
    expect(headline, rows.join('\n')).toBeGreaterThan(-1);
    const actions = rows.findIndex(
      (row, index) => index > headline && row.includes('Review again'),
    );
    expect(actions, rows.join('\n')).toBe(headline + 5);
    const reason = rows.slice(headline + 1, actions).map(panelRow);
    expect(reason).toHaveLength(4);
    for (const reasonRow of reason) expect(reasonRow, rows.join('\n')).not.toBe('');
    expect(reason[0]).toContain('Planner said: The type test');
    expect(reason.at(-1), rows.join('\n')).toMatch(/…$/);
    expect(rows.join('\n')).toContain('End run');
    expect(rows.join('\n')).toContain('↑↓ select · ⏎ confirm');
  });

  it.each([
    [60, 18, 'wraps'],
    [100, 20, 'fits'],
  ])('keeps the row of a cannot answer on a %dx%d panel, where it %s', async (cols, rows) => {
    fixture = createStopContinueFixture(blockedImplementerScript, { consult: cannotConsult });
    const halted = await cli(fixture, ['start', 'smoke']);
    expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);
    const opened = await openHaltedRun(fixture, { heading: 'Needs you' });
    ui = opened.screen;

    terminalSizeStore.__testReset({ cols, rows, isSmall: true });
    await flushEffects();
    const frame = stripAnsiStyles(opened.screen.lastFrame());

    expect(frame).toContain('T001: the planner says it cannot be done');
    expect(frame).toContain('Planner said: No locale service exists');
    expect(frame).not.toContain('Decide for me');
    expect(frame).toContain('End run');
    expect(frame).toContain('↑↓ select · ⏎ confirm');
  });

  it('pages a saved question without moving the transcript behind the menu', async () => {
    const { screen } = await openSavedConsultHalt();
    terminalSizeStore.__testReset({ cols: 60, rows: 12, isSmall: true });
    await flushEffects();
    expect(stripAnsiStyles(screen.lastFrame())).toContain('pgup/pgdn question');
    const position = conversationScrollStore.get().scrollOffset;
    screen.stdin.write('\u001b[5~');
    await flushEffects();
    expect(conversationScrollStore.get().scrollOffset).toBe(position);
  });

  it('keeps the chosen action while the terminal shrinks to 12 rows', async () => {
    const { screen } = await openSavedConsultHalt();
    screen.stdin.write('\u001b[B');
    await flushEffects();
    for (const rows of [16, 15, 14, 13, 12]) {
      terminalSizeStore.__testReset({ cols: 140, rows, isSmall: true });
      await flushEffects();
      const frame = stripAnsiStyles(screen.lastFrame());
      expect(frame).toMatch(/d\s+Decide for me/);
      expect(frame).toContain('Question: greet.ts needs');
      if (!frame.includes('Which file holds the locales?')) {
        screen.stdin.write('\u001b[6~');
        await flushEffects();
        expect(stripAnsiStyles(screen.lastFrame())).toContain('Which file holds the locales?');
        screen.stdin.write('\u001b[5~');
        await flushEffects();
      }
    }
  });
});

/** The words of a panel row, inside its border and its padding. */
function panelRow(row: string | undefined): string {
  return ((row ?? '').split(/[│|]/u)[1] ?? '').trim();
}
