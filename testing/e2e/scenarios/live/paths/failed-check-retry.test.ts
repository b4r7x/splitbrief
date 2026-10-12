import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveRunStatus } from '../../../../../src/core/sessions/run-status.js';
import { resolveSessionDir } from '../../../helpers/live-cli-harness.js';
import { gateLiveMatrixRow } from '../../../helpers/live-harness.js';
import {
  createLivePathsProject,
  disposeLivePathsProject,
  expectCheckoutDelivers,
  FAILING_BASE_FIXTURE,
  LIVE_PATHS_TIMEOUT_MS,
  type LivePathsProject,
  livePathsCli,
  livePathsEnabled,
  ORPHAN_BOUND_MS,
  readRunState,
  resolveLivePathsCrew,
  runSessionDir,
  survivorsAfter,
} from '../../../helpers/live-paths.js';
import { assertPlainStdout, readEventEntries } from '../../../helpers/run-dir-assertions.js';

const itLive = livePathsEnabled() ? it : it.skip;

let project: LivePathsProject | undefined;

afterEach(async () => {
  if (project !== undefined) await disposeLivePathsProject(project);
  project = undefined;
});

describe('live paths: failed check, then retry', { timeout: 2 * LIVE_PATHS_TIMEOUT_MS }, () => {
  itLive('a brief whose suite is red at base takes the retry path and passes', async (ctx) => {
    const crew = resolveLivePathsCrew();
    const gate = await gateLiveMatrixRow(
      [crew.plan.tool, crew.build.tool, crew.review.tool],
      ctx.signal,
    );
    if (gate.kind === 'skip') return ctx.skip(gate.reason);
    // Task cadence runs each brief's checks at its own gate, where a red enters the retry ladder
    // even when the same failure is red at the base.
    project = createLivePathsProject({
      id: 'failed-check-retry',
      fixture: FAILING_BASE_FIXTURE,
      crew,
      workflow: { review: 'task' },
    });
    const { projectDir } = project;
    expect(spawnSync('npm', ['test'], { cwd: projectDir }).status).not.toBe(0);

    const started = await livePathsCli(project, ['start', FAILING_BASE_FIXTURE.feature]);
    expect(started.exitCode, started.stderr).toBe(0);
    assertPlainStdout(started.stdout);
    const sessionId = basename(resolveSessionDir(projectDir));
    const ref = { projectDir, sessionId };
    const ready = readRunState(ref);
    expect(deriveRunStatus({ state: ready, liveness: 'not-alive' }).kind).toBe('ready-to-apply');
    const retried = readEventEntries(runSessionDir(ref)).some(
      (entry) => entry.type === 'task_retry',
    );
    const fixed = ready.tasks.some((task) => task.fix !== undefined);
    expect(
      retried || fixed,
      'neither a retry nor a fix task ran: the first attempt already fixed the failing base test',
    ).toBe(true);

    const applied = await livePathsCli(project, ['continue', sessionId, '--action', 'apply']);
    expect(applied.exitCode, applied.stderr).toBe(0);
    expect(readRunState(ref).closed?.as).toBe('applied');
    expectCheckoutDelivers(projectDir, FAILING_BASE_FIXTURE);
    expect(await survivorsAfter(project.stopWatchingRunners(), ORPHAN_BOUND_MS)).toEqual([]);
  });
});
