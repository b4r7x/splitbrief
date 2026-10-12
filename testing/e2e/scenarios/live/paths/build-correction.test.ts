import { afterEach, describe, expect, it } from 'vitest';
import { plainUserMessage } from '../../../../../src/core/types/user-input.js';
import type { QueueHandler } from '../../../../../src/engine/orchestrator/types.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import {
  executeLiveWorkflow,
  gateLiveMatrixRow,
  runLiveRowWithDeadline,
} from '../../../helpers/live-harness.js';
import {
  buildCallState,
  createLivePathsProject,
  disposeLivePathsProject,
  expectCheckoutDelivers,
  LIVE_PATHS_TIMEOUT_MS,
  type LivePathsFixture,
  type LivePathsProject,
  livePathsEnabled,
  ORPHAN_BOUND_MS,
  pollUntil,
  readRunState,
  resolveLivePathsCrew,
  runSessionDir,
  SLUGIFY_FIXTURE,
  survivorsAfter,
} from '../../../helpers/live-paths.js';
import { eventField, readEventEntries } from '../../../helpers/run-dir-assertions.js';

const itLive = livePathsEnabled() ? it : it.skip;

const CORRECTION =
  "Correction: also export a constant SLUG_SEPARATOR with the value '-' from src/text.mjs.";

const CORRECTED_FIXTURE: LivePathsFixture = {
  ...SLUGIFY_FIXTURE,
  acceptance: [
    SLUGIFY_FIXTURE.acceptance,
    "import { SLUG_SEPARATOR } from './src/text.mjs';",
    "assert.equal(SLUG_SEPARATOR, '-');",
  ].join('\n'),
};

let project: LivePathsProject | undefined;

afterEach(async () => {
  if (project !== undefined) await disposeLivePathsProject(project);
  project = undefined;
});

describe('live paths: correction during BUILD', { timeout: LIVE_PATHS_TIMEOUT_MS }, () => {
  itLive('a message sent during BUILD reaches the running brief once', async (ctx) => {
    const crew = resolveLivePathsCrew();
    const gate = await gateLiveMatrixRow(
      [crew.plan.tool, crew.build.tool, crew.review.tool],
      ctx.signal,
    );
    if (gate.kind === 'skip') return ctx.skip(gate.reason);
    project = createLivePathsProject({ id: 'build-correction', fixture: SLUGIFY_FIXTURE, crew });
    const { projectDir, config, startRun } = project;
    resetAllStores();
    const handlers: { queue?: QueueHandler | null; sessionId?: string } = {};

    await runLiveRowWithDeadline({
      timeoutMs: LIVE_PATHS_TIMEOUT_MS,
      run: async (signal) => {
        const run = startRun((projectSignal) =>
          executeLiveWorkflow({
            projectDir,
            feature: SLUGIFY_FIXTURE.feature,
            effectiveConfig: config,
            signal: AbortSignal.any([signal, projectSignal]),
            onSession: (id) => {
              handlers.sessionId = id;
            },
            sinks: {
              setAbortHandler: () => {},
              setQueueHandler: (handler) => {
                handlers.queue = handler;
              },
            },
          }),
        );
        const ended = run.then(() => {
          throw new Error('the run finished before a BUILD call was live');
        });
        await pollUntil(
          () => {
            const sessionId = handlers.sessionId;
            if (sessionId === undefined) return null;
            return buildCallState({ projectDir, sessionId });
          },
          { ended, timeoutMs: LIVE_PATHS_TIMEOUT_MS, what: 'a live BUILD call' },
        );
        const queue = handlers.queue;
        if (queue == null) throw new Error('the run installed no queue handler');
        const submitted = await queue(plainUserMessage(CORRECTION), 'implementing');
        expect(submitted.status).toBe('accepted');
        await run;
      },
    });

    const sessionId = handlers.sessionId;
    if (sessionId === undefined) throw new Error('the run reported no session');
    const ref = { projectDir, sessionId };
    const events = readEventEntries(runSessionDir(ref));
    const queued = events.filter((entry) => entry.type === 'message_queued');
    expect(queued).toHaveLength(1);
    const messageId = eventField(queued[0]?.data, 'id');
    expect(eventField(queued[0]?.data, 'seat')).toBe('build');
    const deliveries = events.filter((entry) => {
      const ids = eventField(entry.data, 'ids');
      return (
        entry.type === 'queue_drained' &&
        eventField(entry.data, 'seat') === 'build' &&
        Array.isArray(ids) &&
        ids.includes(messageId)
      );
    });
    expect(deliveries, 'deliveries of the correction to BUILD').toHaveLength(1);
    const state = readRunState(ref);
    expect(state.messageQueue).toHaveLength(1);
    expect(state.messageQueue[0]?.deliveredTo?.implementer).toBeDefined();
    expect(state.closed?.as).toBe('applied');
    expectCheckoutDelivers(projectDir, CORRECTED_FIXTURE);
    expect(await survivorsAfter(project.stopWatchingRunners(), ORPHAN_BOUND_MS)).toEqual([]);
  });
});
