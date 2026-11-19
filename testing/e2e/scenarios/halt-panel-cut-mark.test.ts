import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalizeProjectDir } from '../../../src/cli/setup.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { taskId } from '../../../src/core/schemas/task.js';
import { loadState, saveState } from '../../../src/core/state/persistence.js';
import { buildReviewFailedRecoveryIssue } from '../../../src/engine/orchestrator/recovery/builders/review-failed.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { flushEffects, type renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
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
    expect(frame).toContain('Skip task');
    expect(frame).toContain('End run');
    expect(frame).toContain('↑↓ select · ⏎ confirm');
  });

  it.each([
    [60, 18],
    [80, 24],
    [100, 20],
  ])('keeps a long question that wraps on a %dx%d panel', async (cols, rows) => {
    const opened = await openConsultHalt();

    terminalSizeStore.__testReset({ cols, rows, isSmall: true });
    await flushEffects();
    const frame = stripAnsiStyles(opened.screen.lastFrame());

    expect(frame).toContain('Needs you · T001 needs your answer');
    expect(frame).toContain('Question: greet.ts needs');
    expect(frame).toMatch(/… \d+ more lines/);
    expect(frame).toContain('Decide for me');
    expect(frame).toContain('End run');
    expect(frame).toContain('↑↓ select · ⏎ confirm');
  });

  it.each([
    [140, 16],
    [140, 17],
    [80, 16],
  ])('keeps the question and every action on a %dx%d panel', async (cols, rows) => {
    const opened = await openConsultHalt();

    terminalSizeStore.__testReset({ cols, rows, isSmall: true });
    await flushEffects();
    const frame = stripAnsiStyles(opened.screen.lastFrame());

    expect(frame, frame).toContain('Question: greet.ts needs');
    for (const action of ['Try again', 'Decide for me', 'Skip task', 'End run'])
      expect(frame, frame).toContain(action);
    expect(frame, frame).toContain('↑↓ select · ⏎ confirm');
    expect(frame, frame).not.toContain('↓ more');
  });

  it('keeps the task and its files under the long question at 80x24', async () => {
    const opened = await openConsultHalt();

    terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: true });
    await flushEffects();
    const frame = stripAnsiStyles(opened.screen.lastFrame());

    const question = frame.indexOf('Question: greet.ts needs');
    expect(question).toBeGreaterThan(-1);
    expect(question).toBeLessThan(frame.indexOf('Task T001'));
    expect(frame).toContain('Files src/greet.ts');
  });

  it('puts the cut question on the row under the headline at 60x18', async () => {
    const opened = await openConsultHalt();

    terminalSizeStore.__testReset({ cols: 60, rows: 18, isSmall: true });
    await flushEffects();
    const rows = stripAnsiStyles(opened.screen.lastFrame()).split('\n');

    const headline = rows.findLastIndex((row) =>
      row.includes('Needs you · T001 needs your answer'),
    );
    expect(headline, rows.join('\n')).toBeGreaterThan(-1);
    const next = panelRow(rows[headline + 1]);
    expect(next, rows.join('\n')).not.toBe('');
    expect(next).toContain('Question: greet.ts needs');
    expect(next.endsWith('…'), rows.join('\n')).toBe(true);
    expect(panelRow(rows[headline + 2]), rows.join('\n')).toMatch(/^… \d+ more lines?$/);
  });

  it('gives the blank row to the planner reason of a stuck task review at 60x18', async () => {
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
    const reason = rows.slice(headline + 1, headline + 4).map(panelRow);
    expect(reason, rows.join('\n')).toHaveLength(3);
    for (const reasonRow of reason) expect(reasonRow, rows.join('\n')).not.toBe('');
    expect(reason[0]).toContain('Planner said: The type test');
    expect(reason[2], rows.join('\n')).toMatch(/…$/);
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
    expect(frame).toContain('Decide for me');
    expect(frame).toContain('End run');
    expect(frame).toContain('↑↓ select · ⏎ confirm');
  });

  it('marks the cut lines and the hidden actions at every height from 16 down to 12 rows', async () => {
    const opened = await openConsultHalt();

    for (const rows of [16, 15, 14, 13, 12]) {
      terminalSizeStore.__testReset({ cols: 140, rows, isSmall: true });
      await flushEffects();
      const frame = stripAnsiStyles(opened.screen.lastFrame());

      expect(frame, `140x${rows}`).toContain('Needs you');
      expect(frame, `140x${rows}`).toMatch(/… \d+ more lines/);
      expect(frame, `140x${rows}`).toContain('Try again · recommended');
      expectHiddenActionsMarked(frame, `140x${rows}`);
      expect(frame, `140x${rows}`).toContain('↑↓ select · ⏎ confirm');
    }
  });

  it('keeps the selected action and marks the actions on both sides after one ↓ press', async () => {
    const opened = await openConsultHalt();
    opened.screen.stdin.write('\u001b[B');
    await flushEffects();

    for (const rows of [16, 15, 14, 13, 12]) {
      terminalSizeStore.__testReset({ cols: 140, rows, isSmall: true });
      await flushEffects();
      const frame = stripAnsiStyles(opened.screen.lastFrame());

      expect(frame, `140x${rows}`).toMatch(/d\s+Decide for me/);
      expectHiddenActionsMarked(frame, `140x${rows}`);
      expect(frame, `140x${rows}`).toContain('↑↓ select · ⏎ confirm');
    }
  });
});

/** The words of a panel row, inside its border and its padding. */
function panelRow(row: string | undefined): string {
  return ((row ?? '').split(/[│|]/u)[1] ?? '').trim();
}

/** Try again, Decide for me, Skip task and End run: each one off screen sits behind a mark on its side. */
function expectHiddenActionsMarked(frame: string, label: string): void {
  if (!/r\s+Try again/.test(frame)) expect(frame, label).toContain('↑ more');
  if (!/a\s+End run/.test(frame)) expect(frame, label).toContain('↓ more');
}
