import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadState } from '../../../src/core/state/persistence.js';
import { createImplementerBase } from '../../../src/engine/implementers/pipeline/run.js';
import type { InvokeOpts } from '../../../src/engine/implementers/types.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import type { RunPhaseInput } from '../../../src/engine/planners/types.js';
import { makeCallbacks, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makePhaseCallResult } from '#testing/helpers/factories/phase-call.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { TEST_WORKFLOW_SINKS } from '#testing/helpers/orchestrator-context.js';

const dirs: string[] = [];

beforeEach(() => resetAllStores());

afterEach(() => {
  while (dirs.length > 0) cleanupTempDir(dirs.pop() as string);
});

describe('a brief parked inside a direct writer', { timeout: 90_000 }, () => {
  it('continues the cut attempt with a [Continuation] note that carries what it said', async () => {
    const projectDir = createTempDir('orch-int-park-direct');
    dirs.push(projectDir);
    createTestGitRepo(projectDir);
    const sessionId = 'sess-park-direct-writer';
    const feature = 'park a direct writer mid-brief';
    const targetFile = 'src/parked.ts';
    const narration = 'I read the brief and started on src/parked.ts.';

    const task = makeTask({
      id: 'T001',
      action: 'create',
      file: targetFile,
      title: 'Create parked module',
      scope: { inBounds: [targetFile], outOfBounds: ['unrelated files'] },
      evidence: ['src/parked.ts exports parked'],
      typeDefs: 'export const parked: boolean',
    });
    const config = makeConfig({
      implementer: { kind: 'agent', command: 'node', model: 'direct-agent', contextLength: 4096 },
      validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
      workflow: { mode: 'quick', approve: 'none', maxRetries: 1 },
    });
    const planner = makePlanner({
      runPhase: vi.fn(async ({ call }: RunPhaseInput) =>
        makePhaseCallResult({ call, usage: null, ...(call === 'tasks' ? { tasks: [task] } : {}) }),
      ),
    });

    const stop = new AbortController();
    await runWorkflow({
      prepared: makePreparedExecution({ projectDir, sessionId, feature, config }),
      callbacks: makeCallbacks().callbacks,
      sinks: TEST_WORKFLOW_SINKS,
      signal: stop.signal,
      _planner: planner,
      _implementer: createImplementerBase({
        extractsCode: false,
        invoke: async (opts: InvokeOpts) => {
          opts.onOutput(narration);
          stop.abort();
          return makeRunnerCallResult({
            status: 'aborted',
            text: narration,
            error: { code: 'user-abort', message: 'stopped' },
          });
        },
      }),
    });

    const parked = loadState({ projectDir, sessionId });
    expect(parked?.interruptedStep).toMatchObject({
      step: { kind: 'brief', taskId: 'T001', attempt: 0 },
      cut: 'mid-step',
    });
    if (parked === null) return;

    const prompts: string[] = [];
    await runWorkflow({
      prepared: makePreparedExecution({
        projectDir,
        sessionId,
        feature,
        config,
        resumeState: parked,
      }),
      savedState: parked,
      callbacks: makeCallbacks().callbacks,
      sinks: TEST_WORKFLOW_SINKS,
      _planner: planner,
      _implementer: createImplementerBase({
        extractsCode: false,
        invoke: async (opts: InvokeOpts) => {
          prompts.push(opts.prompt);
          mkdirSync(join(opts.projectDir, 'src'), { recursive: true });
          writeFileSync(join(opts.projectDir, targetFile), 'export const parked = true;\n');
          return makeRunnerCallResult({ status: 'completed', text: 'done', usage: null });
        },
      }),
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(
      `[Continuation] The previous attempt of this step was interrupted.\n\nPartial output so far:\n${narration}`,
    );
    expect(loadState({ projectDir, sessionId })).toMatchObject({
      attempt: 0,
      tasks: [{ id: 'T001', status: 'done' }],
    });
  });
});
