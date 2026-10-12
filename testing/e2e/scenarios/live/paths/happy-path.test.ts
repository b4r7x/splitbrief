import { basename } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveRunStatus } from '../../../../../src/core/sessions/run-status.js';
import { resolveSessionDir } from '../../../helpers/live-cli-harness.js';
import { gateLiveMatrixRow } from '../../../helpers/live-harness.js';
import {
  createLivePathsProject,
  disposeLivePathsProject,
  expectCheckoutDelivers,
  LIVE_PATHS_TIMEOUT_MS,
  ORPHAN_BOUND_MS,
  type LivePathsProject,
  livePathsCli,
  livePathsEnabled,
  readRunState,
  resolveLivePathsCrew,
  SLUGIFY_FIXTURE,
  survivorsAfter,
} from '../../../helpers/live-paths.js';
import { assertPlainStdout } from '../../../helpers/run-dir-assertions.js';

const itLive = livePathsEnabled() ? it : it.skip;

let project: LivePathsProject | undefined;

afterEach(async () => {
  if (project !== undefined) await disposeLivePathsProject(project);
  project = undefined;
});

describe('live paths: happy path', { timeout: 2 * LIVE_PATHS_TIMEOUT_MS }, () => {
  itLive('plans, builds and reviews to ready, then Apply closes the run applied', async (ctx) => {
    const crew = resolveLivePathsCrew();
    const gate = await gateLiveMatrixRow(
      [crew.plan.tool, crew.build.tool, crew.review.tool],
      ctx.signal,
    );
    if (gate.kind === 'skip') return ctx.skip(gate.reason);
    project = createLivePathsProject({ id: 'happy-path', fixture: SLUGIFY_FIXTURE, crew });
    const { projectDir } = project;

    const started = await livePathsCli(project, ['start', SLUGIFY_FIXTURE.feature]);
    expect(started.exitCode, started.stderr).toBe(0);
    assertPlainStdout(started.stdout);
    const sessionId = basename(resolveSessionDir(projectDir));
    const ref = { projectDir, sessionId };
    const ready = readRunState(ref);
    expect(deriveRunStatus({ state: ready, liveness: 'not-alive' }).kind).toBe('ready-to-apply');
    expect(ready.tasks.length).toBeGreaterThanOrEqual(1);
    expect(ready.tasks.every((task) => task.status === 'done')).toBe(true);

    const applied = await livePathsCli(project, ['continue', sessionId, '--action', 'apply']);
    expect(applied.exitCode, applied.stderr).toBe(0);
    expect(readRunState(ref).closed?.as).toBe('applied');
    expectCheckoutDelivers(projectDir, SLUGIFY_FIXTURE);

    expect(await survivorsAfter(project.stopWatchingRunners(), ORPHAN_BOUND_MS)).toEqual([]);
  });
});
