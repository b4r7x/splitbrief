import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import type { renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { openHaltedRun, settleOpenedRuns } from '../helpers/halted-run-screen.js';
import {
  cli,
  createStopContinueFixture,
  PLAN_ANSWER,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const UNSERVED = ['C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8'];
const DETAILS = UNSERVED.map((id) => `Criterion ${id} is served by no task.`);
const HEADLINE = 'Needs you · Plan still fails its checks after one repair';

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

/**
 * The fixture planner answers each plan call with 7 criteria that no task serves, so the plan
 * fails its checks again after the one repair, with one detail for each criterion.
 */
function planWithUnservedCriteria(target: StopContinueFixture): void {
  const plan = {
    result: {
      ...PLAN_ANSWER.result,
      criteria: [
        ...PLAN_ANSWER.result.criteria,
        ...UNSERVED.map((id) => ({ id, text: 'served by nothing', checkIds: ['T001-K1'] })),
      ],
    },
  };
  writeFileSync(
    join(target.projectDir, 'tools', 'planner.mjs'),
    `for await (const chunk of process.stdin) void chunk;
process.stdout.write(${JSON.stringify(JSON.stringify(plan))});
`,
  );
}

it('shows each of the 7 details of a plan-checks halt, its actions and the legend at 120x40', async () => {
  fixture = createStopContinueFixture();
  planWithUnservedCriteria(fixture);
  const halted = await cli(fixture, ['start', 'smoke']);
  expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);

  const opened = await openHaltedRun(fixture, { heading: HEADLINE });
  ui = opened.screen;
  expect(opened.state.pendingRecovery).toMatchObject({
    reason: 'plan-checks-failed',
    details: DETAILS,
  });

  const frame = stripAnsiStyles(ui.lastFrame());
  const panel = frame.slice(frame.lastIndexOf(HEADLINE));
  expect(DETAILS.filter((detail) => !panel.includes(detail))).toEqual([]);
  expect(panel).not.toMatch(/… \d+ more lines/);
  expect(panel).toContain('Try again');
  expect(panel).toContain('Send a correction');
  expect(panel).toContain('End run');
  expect(panel).toContain('↑↓ select · ⏎ confirm');
});
