import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import type { renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { consultFailureHaltFixture, plan, startToHalt } from '../helpers/consult-failure-halt.js';
import { openHaltedRun, settleOpenedRuns } from '../helpers/halted-run-screen.js';
import type { StopContinueFixture } from '../helpers/stop-continue-fixture.js';

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;
let ui: ReturnType<typeof renderFeature> | undefined;

beforeEach(() => resetAllStores());

afterEach(async () => {
  ui?.unmount();
  ui = undefined;
  await settleOpenedRuns();
  resetAllStores();
  restorePath?.();
  vi.unstubAllEnvs();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
});

it('says Try again continues the brief on its kept files after its consult stopped', async () => {
  ({ fixture, restorePath } = consultFailureHaltFixture(plan));
  await startToHalt(fixture);

  const opened = await openHaltedRun(fixture, { heading: 'Seat down' });
  ui = opened.screen;

  expect(opened.state.pendingRecovery).toMatchObject({
    reason: 'planner-call-failed',
    seat: 'plan',
    taskId: 'T001',
  });
  const frame = stripAnsiStyles(ui.lastFrame());
  expect(frame).toMatch(/Try again {2,}continues this brief/);
  expect(frame).not.toContain('restarts this brief');
});
