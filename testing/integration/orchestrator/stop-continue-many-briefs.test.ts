import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { loadState } from '../../../src/core/state/persistence.js';
import { readSession } from '../../../src/core/sessions/io.js';
import { deriveRunStatus } from '../../../src/core/sessions/run-status.js';
import { createEventBus } from '../../../src/engine/events/bus.js';
import { createStdoutTextSink } from '../../../src/engine/events/sinks/stdout-text.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import type { ImplementerOptions } from '../../../src/engine/implementers/types.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import {
  makeCallbacks,
  makeImplementer,
  makePlanner,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { assertPlainStdout } from '../../e2e/helpers/run-dir-assertions.js';
import {
  passingReviewVerdict,
  planFromTasks,
  typedCallPlanAndReview,
} from '#testing/helpers/typed-planner.js';

const BRIEF_COUNT = 13;
const STOP_AFTER = 'T005';

const TASK_IDS = Array.from(
  { length: BRIEF_COUNT },
  (_, i) => `T${String(i + 1).padStart(3, '0')}`,
);

const TASKS = TASK_IDS.map((id, i) =>
  makeTask({
    id,
    title: `Create module ${id}`,
    suggestedFiles: [`src/${id.toLowerCase()}.ts`],
    dependsOn: i === 0 ? [] : [TASK_IDS[i - 1] ?? ''],
    scope: { inBounds: [`src/${id.toLowerCase()}.ts`], outOfBounds: ['every other file'] },
    evidence: [`src/${id.toLowerCase()}.ts exports ${id.toLowerCase()}`],
    typeDefs: `export const ${id.toLowerCase()}: boolean`,
  }),
);

const dirs: string[] = [];

beforeEach(() => resetAllStores());

afterEach(() => {
  while (dirs.length > 0) cleanupTempDir(dirs.pop() as string);
});

function plainCapture(): { out: Writable; text: () => string } {
  let text = '';
  const out = new Writable({
    write(chunk, _encoding, done) {
      text += String(chunk);
      done();
    },
  });
  return { out, text: () => text };
}

describe('a thirteen-brief run stopped between briefs and continued', { timeout: 180_000 }, () => {
  it('builds every brief exactly once and every record agrees on thirteen', async () => {
    const projectDir = createTempDir('orch-int-stop-continue-13');
    dirs.push(projectDir);
    createTestGitRepo(projectDir);
    const sessionId = 'sess-stop-continue-13';
    const ref = { projectDir, sessionId };
    const feature = 'thirteen coherent briefs';
    const config = makeNoValidationConfig({
      workflow: { approve: 'none', maxRetries: 1, isolation: 'staged-copy' },
      approval: { feedRejectionsToPlanner: false },
    });

    const builds: string[] = [];
    const continuations: ImplementerOptions['continuation'][] = [];
    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi.fn(async (opts: ImplementerOptions) => {
        builds.push(opts.task.id);
        continuations.push(opts.continuation);
        const path = join(opts.projectDir, opts.task.suggestedFiles[0]);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `export const ${opts.task.id.toLowerCase()} = true;\n`);
        return { success: true, output: 'written', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
      retry: vi.fn(async () => {
        throw new Error('no brief in this run needs a retry');
      }),
    });
    let reviewCalls = 0;
    const planner = makePlanner({
      typedCall: typedCallPlanAndReview(
        () => planFromTasks(TASKS),
        (prompt) => {
          reviewCalls += 1;
          return passingReviewVerdict(prompt);
        },
      ),
    });

    const stop = new AbortController();
    const firstBus = createEventBus();
    const firstEvents: EngineEvent[] = [];
    const firstPlain = plainCapture();
    firstBus.subscribe(createStdoutTextSink({ output: firstPlain.out }));
    firstBus.subscribe((event) => {
      firstEvents.push(event);
      if (event.type === 'task_completed' && event.taskId === STOP_AFTER) stop.abort();
    });

    await runWorkflow({
      prepared: makePreparedExecution({ ...ref, feature, config }),
      callbacks: makeCallbacks().callbacks,
      sinks: TEST_SINKS,
      signal: stop.signal,
      eventBus: firstBus,
      _planner: planner,
      _implementer: implementer,
    });

    const parked = loadState(ref);
    if (parked === null) throw new Error('the stopped run saved no state');
    expect(parked.closed).toBeUndefined();
    expect(parked.tasks.map((task) => task.id)).toEqual(TASK_IDS);
    const doneAtStop = parked.tasks.filter((task) => task.status === 'done').map((t) => t.id);
    expect(doneAtStop).toEqual(TASK_IDS.slice(0, 5));
    expect(parked.tasks.slice(5).every((task) => task.status === 'pending')).toBe(true);
    expect(builds).toEqual(TASK_IDS.slice(0, 5));
    // The park names the next brief as the step to pick up, at its first attempt.
    expect(parked.interruptedStep?.step).toEqual({ kind: 'brief', taskId: 'T006', attempt: 0 });
    expect(reviewCalls).toBe(0);
    expect(firstEvents.some((event) => event.type === 'workflow_complete')).toBe(false);
    expect(firstPlain.text()).not.toMatch(/^done: /m);

    const resumedBus = createEventBus();
    const resumedEvents: EngineEvent[] = [];
    const resumedPlain = plainCapture();
    resumedBus.subscribe(createStdoutTextSink({ output: resumedPlain.out }));
    resumedBus.subscribe((event) => resumedEvents.push(event));

    await runWorkflow({
      prepared: makePreparedExecution({ ...ref, feature, config, resumeState: parked }),
      savedState: parked,
      callbacks: makeCallbacks().callbacks,
      sinks: TEST_SINKS,
      eventBus: resumedBus,
      _planner: planner,
      _implementer: implementer,
    });

    // BUILD calls: one per brief, in order, none repeated across the stop and none skipped.
    expect(builds).toEqual(TASK_IDS);
    expect(implementer.retry).not.toHaveBeenCalled();
    // The stop fell between briefs, so no BUILD call resumes a cut attempt.
    expect(continuations).toEqual(TASK_IDS.map(() => undefined));
    const resumedStarts = resumedEvents
      .filter((event) => event.type === 'task_started')
      .map((event) => event.taskId);
    expect(resumedStarts).toEqual(TASK_IDS.slice(5));
    expect(reviewCalls).toBe(1);

    const final = loadState(ref);
    if (final === null) throw new Error('the continued run saved no state');
    expect(final.tasks.map((task) => [task.id, task.status])).toEqual(
      TASK_IDS.map((id) => [id, 'done']),
    );
    expect(final.pendingRecovery).toBeUndefined();

    const session = readSession(ref);
    if (session === null || session.summary === null) throw new Error('Missing run summary');
    expect(session.status).toBe('open');
    expect(deriveRunStatus({ state: final, liveness: 'not-alive' })).toEqual({
      kind: 'ready-to-apply',
      override: false,
    });
    expect(session.summary.totalTasks).toBe(BRIEF_COUNT);
    expect(session.summary.completedByLocal).toBe(BRIEF_COUNT);
    expect(session.summary.failed).toBe(0);
    expect(session.summary.escalatedToPlanner).toBe(0);
    expect((session.summary.taskBreakdown ?? []).map((task) => task.taskId).sort()).toEqual(
      TASK_IDS,
    );

    // The --plain projection: the first run printed the first five, the continuation the rest,
    // and its `done:` count is the run's whole completion count, not only what it built.
    const completed = assertPlainStdout(resumedPlain.text());
    expect(completed).toBe(BRIEF_COUNT);
    const plainDone = (text: string) =>
      [...text.matchAll(/^task (T\d{3}): done /gm)].map((match) => match[1]);
    expect([...plainDone(firstPlain.text()), ...plainDone(resumedPlain.text())]).toEqual(TASK_IDS);
  });
});
