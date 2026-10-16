import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PLAN_JSON_FILE } from '../../../../../src/core/paths.js';
import { deriveRunStatus } from '../../../../../src/core/sessions/run-status.js';
import { loadState } from '../../../../../src/core/state/persistence.js';
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
  runSessionDir,
  SLUGIFY_FIXTURE,
  startAndSignalWhen,
  survivorsAfter,
} from '../../../helpers/live-paths.js';
import {
  assertPlainStdout,
  countRunnerCalls,
  readEventEntries,
} from '../../../helpers/run-dir-assertions.js';

const itLive = livePathsEnabled() ? it : it.skip;

const FEATURE_FILE = 'src/text.mjs';

let project: LivePathsProject | undefined;

afterEach(async (ctx) => {
  if (project !== undefined)
    await disposeLivePathsProject(project, ctx.task.result?.state === 'fail');
  project = undefined;
});

describe('live paths: stop, continue, end', { timeout: 3 * LIVE_PATHS_TIMEOUT_MS }, () => {
  itLive('a run stopped during BUILD continues at its brief and applies', async (ctx) => {
    const crew = resolveLivePathsCrew();
    const gate = await gateLiveMatrixRow(
      [crew.plan.tool, crew.build.tool, crew.review.tool],
      ctx.signal,
    );
    if (gate.kind === 'skip') return ctx.skip(gate.reason);
    project = createLivePathsProject({ id: 'stop-continue', fixture: SLUGIFY_FIXTURE, crew });
    const { projectDir } = project;

    const stopped = await startAndSignalWhen(project, {
      feature: SLUGIFY_FIXTURE.feature,
      signal: 'SIGINT',
      probe: (ref) => buildCallState(ref) !== null,
      what: 'a live BUILD call',
    });
    expect(stopped.exitCode, stopped.stderr).toBe(0);
    const ref = { projectDir, sessionId: stopped.sessionId };
    const parked = readRunState(ref);
    expect(deriveRunStatus({ state: parked, liveness: 'not-alive' }).kind).toBe('open');
    expect(parked.phase).toBe('implementing');
    expect(parked.interruptedStep?.cut).toBe('mid-step');
    expect(parked.pendingRecovery).toBeUndefined();
    const parkedTask = parked.tasks[parked.currentTaskIndex];
    expect(parkedTask?.status).toBe('in_progress');
    const planPath = join(runSessionDir(ref), PLAN_JSON_FILE);
    const plan = readFileSync(planPath, 'utf-8');
    const planCalls = countRunnerCalls(readEventEntries(runSessionDir(ref))).planner;

    const resumed = await livePathsCli(project, ['continue', stopped.sessionId]);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    assertPlainStdout(resumed.stdout);
    expect(readFileSync(planPath, 'utf-8'), 'the continuation planned again').toBe(plan);
    expect(countRunnerCalls(readEventEntries(runSessionDir(ref))).planner).toBe(planCalls);
    const ready = readRunState(ref);
    expect(deriveRunStatus({ state: ready, liveness: 'not-alive' }).kind).toBe('ready-to-apply');
    expect(ready.tasks.find((task) => task.id === parkedTask?.id)?.status).toBe('done');

    const applied = await livePathsCli(project, [
      'continue',
      stopped.sessionId,
      '--action',
      'apply',
    ]);
    expect(applied.exitCode, applied.stderr).toBe(0);
    expect(readRunState(ref).closed?.as).toBe('applied');
    expectCheckoutDelivers(projectDir, SLUGIFY_FIXTURE);
    expect(await survivorsAfter(project.stopWatchingRunners(), ORPHAN_BOUND_MS)).toEqual([]);
  });

  itLive(
    'a run stopped after BUILD wrote its file ends headless and keeps run.patch',
    async (ctx) => {
      const crew = resolveLivePathsCrew();
      const gate = await gateLiveMatrixRow(
        [crew.plan.tool, crew.build.tool, crew.review.tool],
        ctx.signal,
      );
      if (gate.kind === 'skip') return ctx.skip(gate.reason);
      project = createLivePathsProject({ id: 'end-run', fixture: SLUGIFY_FIXTURE, crew });
      const { projectDir } = project;
      const checkoutSource = readFileSync(join(projectDir, FEATURE_FILE), 'utf-8');

      const stopped = await startAndSignalWhen(project, {
        feature: SLUGIFY_FIXTURE.feature,
        signal: 'SIGINT',
        probe: (ref) => {
          const workspace = loadState(ref)?.workspace;
          if (workspace === undefined) return false;
          const file = join(workspace.path, FEATURE_FILE);
          return existsSync(file) && readFileSync(file, 'utf-8').includes('slugify');
        },
        what: `BUILD writing slugify into the workspace ${FEATURE_FILE}`,
      });
      expect(stopped.exitCode, stopped.stderr).toBe(0);
      const ref = { projectDir, sessionId: stopped.sessionId };
      const parked = readRunState(ref);
      expect(deriveRunStatus({ state: parked, liveness: 'not-alive' }).kind).toBe('open');
      const workspace = parked.workspace;
      if (workspace === undefined) throw new Error('the stopped run has no workspace');

      const ended = await livePathsCli(project, [
        'continue',
        stopped.sessionId,
        '--action',
        'end-run',
      ]);
      expect(ended.exitCode, ended.stderr).toBe(0);
      expect(ended.stdout).toBe(`Run ${stopped.sessionId} closed.\n`);
      const closed = readRunState(ref).closed;
      expect(closed?.as).toBe('ended');
      if (closed?.patch === undefined) throw new Error('the ended run saved no patch');
      expect(readFileSync(join(projectDir, closed.patch), 'utf-8')).toContain('slugify');
      expect(existsSync(workspace.path)).toBe(false);
      expect(readFileSync(join(projectDir, FEATURE_FILE), 'utf-8')).toBe(checkoutSource);
      expect(await survivorsAfter(project.stopWatchingRunners(), ORPHAN_BOUND_MS)).toEqual([]);
    },
  );
});
