import { afterEach, describe, expect, it } from 'vitest';
import { readRunnerPids } from '../../../../../src/core/sessions/runner-pids.js';
import { deriveRunStatus } from '../../../../../src/core/sessions/run-status.js';
import { gateLiveMatrixRow } from '../../../helpers/live-harness.js';
import {
  buildCallState,
  createLivePathsProject,
  disposeLivePathsProject,
  expectCheckoutDelivers,
  LIVE_PATHS_TIMEOUT_MS,
  type LivePathsProject,
  livePathsCli,
  livePathsEnabled,
  ORPHAN_BOUND_MS,
  readRunState,
  resolveLivePathsCrew,
  SLUGIFY_FIXTURE,
  startAndSignalWhen,
  survivorsAfter,
} from '../../../helpers/live-paths.js';
import { assertPlainStdout } from '../../../helpers/run-dir-assertions.js';

const itLive = livePathsEnabled() ? it : it.skip;

let project: LivePathsProject | undefined;
/** The tool processes still alive `ORPHAN_BOUND_MS` after the CLI was killed. */
let survivors: number[] | undefined;

afterEach(async () => {
  if (project !== undefined) await disposeLivePathsProject(project);
  project = undefined;
});

describe('live paths: crash mid-BUILD', { timeout: 3 * LIVE_PATHS_TIMEOUT_MS }, () => {
  itLive('a CLI killed during BUILD reopens, continues and applies', async (ctx) => {
    const crew = resolveLivePathsCrew();
    const gate = await gateLiveMatrixRow(
      [crew.plan.tool, crew.build.tool, crew.review.tool],
      ctx.signal,
    );
    if (gate.kind === 'skip') return ctx.skip(gate.reason);
    project = createLivePathsProject({ id: 'crash-build', fixture: SLUGIFY_FIXTURE, crew });
    const { projectDir } = project;

    const crashed = await startAndSignalWhen(project, {
      feature: SLUGIFY_FIXTURE.feature,
      signal: 'SIGKILL',
      probe: (ref) => buildCallState(ref) !== null,
      what: 'a live BUILD call',
    });
    expect(crashed.exitCode).toBeNull();
    const ref = { projectDir, sessionId: crashed.sessionId };
    const ledger = readRunnerPids(ref);
    expect(ledger, 'the killed run left no tool process on its ledger').not.toEqual([]);
    survivors = await survivorsAfter(ledger, ORPHAN_BOUND_MS);

    const resumed = await livePathsCli(project, ['continue', crashed.sessionId]);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    assertPlainStdout(resumed.stdout);
    expect(
      await survivorsAfter(ledger, 0),
      'the continuation left a killed run tool alive',
    ).toEqual([]);
    const ready = readRunState(ref);
    expect(deriveRunStatus({ state: ready, liveness: 'not-alive' }).kind).toBe('ready-to-apply');

    const applied = await livePathsCli(project, [
      'continue',
      crashed.sessionId,
      '--action',
      'apply',
    ]);
    expect(applied.exitCode, applied.stderr).toBe(0);
    expect(readRunState(ref).closed?.as).toBe('applied');
    expectCheckoutDelivers(projectDir, SLUGIFY_FIXTURE);
    expect(readRunnerPids(ref)).toEqual([]);
  });

  itLive('no tool process outlives the killed CLI beyond the bound', (ctx) => {
    if (survivors === undefined) return ctx.skip('the crash run measured no survivors');
    expect(survivors).toEqual([]);
  });
});
