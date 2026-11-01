import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, type AppProps } from '../../../src/app/root.js';
import { canonicalizeProjectDir } from '../../../src/cli/setup.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { readRunRecord } from '../../../src/core/sessions/run-record-io.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { hydrateRun } from '../../../src/features/workflow/run-history.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { configStore } from '../../../src/stores/project/config.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  cli,
  createStopContinueFixture,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const VIEWPORT = { cols: 160, rows: 40 };

let fixture: StopContinueFixture | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  resetAllStores();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

/** The fixture's plan with a criterion no task serves, so it fails its checks after the one repair. */
function planWithUnservedCriterion(target: StopContinueFixture): void {
  const plannerPath = join(target.projectDir, 'tools', 'planner.mjs');
  const script = readFileSync(plannerPath, 'utf8');
  const line = /^const PLAN = (.*);$/m.exec(script);
  if (line?.[1] === undefined) throw new Error('the fixture planner names no PLAN');
  const plan = JSON.parse(JSON.parse(line[1]));
  plan.result.criteria.push({ id: 'C2', text: 'served by nothing', checkIds: [] });
  writeFileSync(
    plannerPath,
    script.replace(line[0], `const PLAN = ${JSON.stringify(JSON.stringify(plan))};`),
  );
}

describe('e2e: a run that halted in planning, opened at rest', () => {
  it('marks planning stopped in the sidebar', async () => {
    resetAllStores();
    fixture = createStopContinueFixture();
    planWithUnservedCriterion(fixture);

    const halted = await cli(fixture, ['start', 'smoke']);
    expect(halted.exitCode, halted.stderr).toBe(1);

    vi.stubEnv('XDG_STATE_HOME', fixture.stateHome);
    const projectDir = await canonicalizeProjectDir({ project: fixture.projectDir });
    const sessionId = readActive(projectDir);
    if (sessionId === null)
      throw new Error(`the halted run left no active session: ${halted.stderr}`);
    const ref = { projectDir, sessionId };
    const state = loadState(ref);
    expect(state?.phase).toBe('planning');
    expect(state?.tasks).toEqual([]);
    expect(state?.pendingRecovery?.reason).toBe('plan-checks-failed');

    const record = readRunRecord(ref);
    configStore.load(projectDir);
    terminalSizeStore.__testReset({ ...VIEWPORT, isSmall: false });
    await hydrateRun(record);
    routerStore.init({ screen: 'workflow', run: record, execution: { kind: 'at-rest' } });
    const screen = renderFeature(createElement<AppProps>(App, {}), VIEWPORT);
    try {
      await vi.waitFor(() => expect(stripAnsiStyles(screen.lastFrame())).toContain('Tasks'));

      expect(stripAnsiStyles(screen.lastFrame())).toContain('Planning stopped');
    } finally {
      screen.unmount();
    }
  });
});
