import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

/**
 * The planner passes the implementer's question to the user with no default, so the headless run
 * halts on it. The plan prompt quotes this script from the repository, so the match is the
 * prompt's own first heading, not a phrase anywhere in it.
 */
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
      expect(frame, `140x${rows}`).toContain('Try again recommended');
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

/** Try again, Decide for me, Skip task and End run: each one off screen sits behind a mark on its side. */
function expectHiddenActionsMarked(frame: string, label: string): void {
  if (!/r\s+Try again/.test(frame)) expect(frame, label).toContain('↑ more');
  if (!/a\s+End run/.test(frame)) expect(frame, label).toContain('↓ more');
}
