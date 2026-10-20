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

const GUIDANCE = JSON.stringify({
  answer: {
    diagnosis: 'The implementer wrote nothing.',
    action: 'guidance',
    instructions: 'Write the greeting helper as the brief says.',
    context: null,
  },
});

/**
 * The planner answers every consult with guidance, so the brief spends its consults and halts.
 * The plan prompt quotes this script from the repository, so the match is the prompt's own
 * first heading, not a phrase anywhere in it.
 */
function guidingConsult(): string {
  return `(prompt) => {
  const heading = prompt.split('\\n').find((line) => line.startsWith('# '));
  return heading === '# Consult on a failing task' || heading === '# Consult continued'
    ? ${JSON.stringify(GUIDANCE)}
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

/** Runs the fixture until its brief spends its consults and opens the halt on the run screen. */
async function openConsultHalt() {
  fixture = createStopContinueFixture(blockedImplementerScript, {
    consult: guidingConsult,
  });
  const halted = await cli(fixture, ['start', 'smoke']);
  expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);

  const opened = await openHaltedRun(fixture, { heading: 'Needs you' });
  ui = opened.screen;
  return opened;
}

describe('e2e: a halt panel too short for its text', () => {
  it('marks a detail over the cap with …, the cut lines at 80x24, and keeps the actions and the legend', async () => {
    const opened = await openConsultHalt();
    expect(opened.state.pendingRecovery).toMatchObject({
      reason: 'consult-bound-spent',
      details: expect.arrayContaining([
        expect.stringContaining('Last diagnosis: Implementer is blocked: greet.ts needs'),
      ]),
    });

    const diagnosis = opened.state.pendingRecovery?.details.find((line) =>
      line.startsWith('Last diagnosis: '),
    );
    expect(diagnosis?.endsWith('…')).toBe(true);
    const wide = stripAnsiStyles(opened.screen.lastFrame());
    expect(wide).toContain(diagnosis?.slice(diagnosis.lastIndexOf(' ') + 1));
    expect(wide).not.toContain('...');

    terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: true });
    await flushEffects();
    const frame = stripAnsiStyles(opened.screen.lastFrame());

    expect(frame).toMatch(/… \d+ more lines/);
    expect(frame).toContain('Skip task');
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
      expect(frame, `140x${rows}`).toContain('Continue recommended');
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

      expect(frame, `140x${rows}`).toMatch(/s\s+Skip task/);
      expectHiddenActionsMarked(frame, `140x${rows}`);
      expect(frame, `140x${rows}`).toContain('↑↓ select · ⏎ confirm');
    }
  });
});

/** Continue, Skip task and End run: each one off screen sits behind a mark on its side. */
function expectHiddenActionsMarked(frame: string, label: string): void {
  if (!/c\s+Continue/.test(frame)) expect(frame, label).toContain('↑ more');
  if (!/a\s+End run/.test(frame)) expect(frame, label).toContain('↓ more');
}
