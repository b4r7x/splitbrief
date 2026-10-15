import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveImplementerProfiles } from '../../../../../src/core/config/accessors/implementer-profiles.js';
import { deriveRunStatus } from '../../../../../src/core/sessions/run-status.js';
import { createEventBus } from '../../../../../src/engine/events/bus.js';
import { createImplementerPublisher } from '../../../../../src/engine/orchestrator/events.js';
import { runWorkflow } from '../../../../../src/engine/orchestrator/run/workflow.js';
import { createImplementer } from '../../../../../src/engine/runners/factory.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import {
  executeLiveWorkflow,
  gateLiveMatrixRow,
  runLiveRowWithDeadline,
} from '../../../helpers/live-harness.js';
import {
  createLivePathsProject,
  disposeLivePathsProject,
  expectCheckoutDelivers,
  FAILING_BASE_FIXTURE,
  LIVE_PATHS_TIMEOUT_MS,
  type LivePathsProject,
  livePathsEnabled,
  ORPHAN_BOUND_MS,
  readRunState,
  resolveLivePathsCrew,
  runSessionDir,
  survivorsAfter,
  withHiddenRetryCheck,
} from '../../../helpers/live-paths.js';
import { eventField, readEventEntries } from '../../../helpers/run-dir-assertions.js';

const itLive = livePathsEnabled() ? it : it.skip;

let project: LivePathsProject | undefined;

afterEach(async () => {
  if (project !== undefined) await disposeLivePathsProject(project);
  project = undefined;
});

describe('live paths: failed check, then retry', { timeout: 2 * LIVE_PATHS_TIMEOUT_MS }, () => {
  itLive('a hidden check forces retry feedback and passes', async (ctx) => {
    const crew = resolveLivePathsCrew();
    const gate = await gateLiveMatrixRow(
      [crew.plan.tool, crew.build.tool, crew.review.tool],
      ctx.signal,
    );
    if (gate.kind === 'skip') return ctx.skip(gate.reason);
    project = createLivePathsProject({
      id: 'failed-check-retry',
      fixture: FAILING_BASE_FIXTURE,
      crew,
      workflow: { review: 'task' },
    });
    const { projectDir, tmpDir, config, startRun } = project;
    expect(spawnSync('npm', ['test'], { cwd: projectDir }).status).not.toBe(0);
    resetAllStores();
    let retryFeedback: string[] = [];

    const { sessionId } = await runLiveRowWithDeadline({
      timeoutMs: LIVE_PATHS_TIMEOUT_MS,
      run: (signal) =>
        startRun((projectSignal) =>
          executeLiveWorkflow({
            projectDir,
            feature: FAILING_BASE_FIXTURE.feature,
            effectiveConfig: config,
            signal: AbortSignal.any([signal, projectSignal, ctx.signal]),
            runWorkflow: async (opts) => {
              const { prepared } = opts;
              const bus = createEventBus();
              const delegate = await createImplementer(prepared.config, {
                preparedConfig: prepared.config,
                preparationId: prepared.preparationId,
                gates: prepared.gates,
                slot: {
                  role: 'implementer',
                  profile: resolveImplementerProfiles(prepared.config).defaultProfile.name,
                },
                publisher: createImplementerPublisher(bus),
              });
              const hidden = withHiddenRetryCheck(delegate, join(tmpDir, 'hidden-acceptance.mjs'));
              retryFeedback = hidden.feedback;
              const summary = await runWorkflow({
                ...opts,
                eventBus: bus,
                _implementer: hidden.implementer,
              });
              const ready = readRunState(prepared.session.ref);
              expect(deriveRunStatus({ state: ready, liveness: 'not-alive' }).kind).toBe(
                'ready-to-apply',
              );
              return summary;
            },
          }),
        ),
    });
    const ref = { projectDir, sessionId };
    const retries = readEventEntries(runSessionDir(ref)).filter(
      (entry) => entry.type === 'task_retry',
    );
    expect(retries.length).toBeGreaterThan(0);
    expect(eventField(retries[0]?.data, 'error')).toContain('Hidden acceptance check:');
    expect(retryFeedback[0]).toContain('Hidden acceptance check:');

    expect(readRunState(ref).closed?.as).toBe('applied');
    expectCheckoutDelivers(projectDir, FAILING_BASE_FIXTURE);
    expect(await survivorsAfter(project.stopWatchingRunners(), ORPHAN_BOUND_MS)).toEqual([]);
  });
});
