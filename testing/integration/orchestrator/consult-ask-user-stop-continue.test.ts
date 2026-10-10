import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConsultAnswer } from '../../../src/core/schemas/consult.js';
import { plainUserMessage } from '../../../src/core/types/user-input.js';
import type { PlannerConversation } from '../../../src/core/schemas/workflow.js';
import { deriveRunStatus } from '../../../src/core/sessions/run-status.js';
import { loadState } from '../../../src/core/state/persistence.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import type { ImplementerOptions, RetryOptions } from '../../../src/engine/implementers/types.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import type { RunnerGate } from '../../../src/engine/runners/prepared-execution.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { executableReceipt } from '#testing/helpers/custom-command-based.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { TEST_WORKFLOW_SINKS } from '#testing/helpers/orchestrator-context.js';
import {
  makeCallbacks,
  makeImplementer,
  makePlanner,
  runWorkspaceDir,
} from '#testing/helpers/orchestrator-factories.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { planFromTasks, typedCallPlanAndConsult } from '#testing/helpers/typed-planner.js';
import { seedValidationProject } from '#testing/helpers/validation-project.js';

const dirs: string[] = [];

beforeEach(() => resetAllStores());

afterEach(() => {
  while (dirs.length > 0) cleanupTempDir(dirs.pop() as string);
});

function gates(preparationId: string): ReadonlyArray<RunnerGate> {
  return [
    {
      kind: 'cli',
      slot: { role: 'planner' },
      preparationId,
      tool: 'claude-code',
      executable: executableReceipt(),
    },
    {
      kind: 'agent',
      slot: { role: 'implementer', profile: 'default' },
      preparationId,
      command: { kind: 'validated-config' },
    },
  ];
}

const QUESTION = 'Which marker does validate.mjs expect?';

const askUser: ConsultAnswer = {
  answer: {
    diagnosis: 'The marker is a product decision',
    action: 'ask-user',
    question: QUESTION,
    whyOnlyUserCanAnswer: 'Only the operator knows the marker.',
    choices: null,
    default: null,
  },
};

describe('a run stopped while a consult question waits', { timeout: 120_000 }, () => {
  it('continues at its brief and asks the question again instead of re-entering planning', async () => {
    const projectDir = createTempDir('orch-int-consult-ask-stop');
    dirs.push(projectDir);
    createTestGitRepo(projectDir);
    seedValidationProject(projectDir, 'from-retry');
    const sessionId = 'sess-consult-ask-stop';
    const ref = { projectDir, sessionId };
    const targetFile = 'src/loop.ts';
    const feature = 'stop on a consult question';

    const task = makeTask({
      id: 'T001',
      action: 'create',
      suggestedFiles: [targetFile],
      title: 'Create the marker module',
      description: 'Create a module whose marker only the operator knows.',
      implementationSteps: ['Create src/loop.ts with the marker export.'],
      tests: ['node validate.mjs passes'],
      checks: [{ id: 'K-retry', kind: 'test', value: targetFile, required: true }],
      scope: { inBounds: [targetFile], outOfBounds: ['unrelated files'] },
      evidence: ['validation passes after the operator answers'],
      typeDefs: 'export const loop: string',
    });
    let planCalls = 0;
    const planner = makePlanner({
      typedCall: typedCallPlanAndConsult(
        () => {
          planCalls += 1;
          return planFromTasks([task]);
        },
        () => askUser,
      ),
    });
    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi.fn(async (opts: ImplementerOptions) => {
        mkdirSync(join(opts.projectDir, 'src'), { recursive: true });
        writeFileSync(join(opts.projectDir, targetFile), 'export const loop = "from-initial";\n');
        return { success: true, output: 'initial', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
      retry: vi.fn(async (opts: RetryOptions) => {
        if (opts.kind === 'local') {
          return {
            success: false,
            output: '',
            error: 'local retry still misses the marker',
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        }
        writeFileSync(join(opts.projectDir, targetFile), 'export const loop = "from-retry";\n');
        return { success: true, output: 'fixed', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const config = makeConfig({
      implementer: { kind: 'agent', command: 'node', model: 'direct-agent', contextLength: 4096 },
      validation: { endChecks: false, testCommand: 'node validate.mjs' },
      workflow: { approve: 'none', review: 'task' },
    });

    const stop = new AbortController();
    const firstAsked: PlannerConversation[] = [];
    await runWorkflow({
      prepared: makePreparedExecution({ ...ref, feature, config, gates }),
      callbacks: makeCallbacks({
        onPlannerReply: (conversation) => {
          firstAsked.push(conversation);
          stop.abort();
          return new Promise(() => {});
        },
      }).callbacks,
      sinks: TEST_WORKFLOW_SINKS,
      signal: stop.signal,
      _planner: planner,
      _implementer: implementer,
    });

    expect(firstAsked.map((conversation) => conversation.text)).toEqual([QUESTION]);
    const parked = loadState(ref);
    if (parked === null) throw new Error('the stopped run saved no state');
    expect(parked.closed).toBeUndefined();
    expect(planCalls).toBe(1);
    const status = deriveRunStatus({ state: parked, liveness: 'not-alive' });
    if (status.kind !== 'open') throw new Error(`expected an open run, got ${status.kind}`);
    expect(status.resumeAt).toMatchObject({ kind: 'brief', taskId: 'T001' });

    const secondAsked: PlannerConversation[] = [];
    const resumedEvents: EngineEvent[] = [];
    await runWorkflow({
      prepared: makePreparedExecution({ ...ref, feature, config, gates, resumeState: parked }),
      savedState: parked,
      callbacks: makeCallbacks({
        onPlannerReply: async (conversation) => {
          secondAsked.push(conversation);
          return plainUserMessage('from-retry');
        },
      }).callbacks,
      sinks: TEST_WORKFLOW_SINKS,
      _planner: planner,
      _implementer: implementer,
      _eventSink: (event) => resumedEvents.push(event),
    });

    expect(planCalls).toBe(1);
    expect(secondAsked.map((conversation) => conversation.text)).toEqual([QUESTION]);
    expect(resumedEvents.filter((event) => event.type === 'error')).toEqual([]);
    expect(resumedEvents.find((event) => event.type === 'task_completed')).toMatchObject({
      taskId: 'T001',
    });
    expect(readFileSync(join(runWorkspaceDir(ref), targetFile), 'utf-8')).toContain('from-retry');
    const final = loadState(ref);
    expect(final?.pendingPlannerConversation).toBeUndefined();
    expect(final?.userAnswers).toEqual([{ reply: QUESTION, answer: 'from-retry' }]);
  });
});
