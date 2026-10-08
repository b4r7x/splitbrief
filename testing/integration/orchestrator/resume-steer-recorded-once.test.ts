import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInitialState, transition } from '../../../src/core/state/machine.js';
import { saveState } from '../../../src/core/state/persistence.js';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import { runTrackedWorkflow, settleTrackedWorkflows } from '#testing/helpers/tracked-workflow.js';
import type { ImplementerOptions } from '../../../src/engine/implementers/types.js';
import {
  makeCallbacks,
  makeImplementer,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { planFromTasks, scriptedTypedCall } from '#testing/helpers/typed-planner.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { TEST_WORKFLOW_SINKS } from '#testing/helpers/orchestrator-context.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { appendEngineEvent, appendMessage } from '../../../src/core/sessions/log-writer.js';
import { reactivateExistingSession } from '../../../src/core/sessions/active-pointer.js';
import { createPlannerBase } from '../../../src/engine/planners/base.js';
import { executableReceipt } from '#testing/helpers/custom-command-based.js';
import {
  parsePreparedConfig,
  type PreparedExecution,
} from '../../../src/engine/runners/prepared-execution.js';

const dirs: string[] = [];

beforeEach(() => resetAllStores());

afterEach(async () => {
  await settleTrackedWorkflows();
  while (dirs.length > 0) cleanupTempDir(dirs.pop() as string);
});

function setupProject(): string {
  const projectDir = createTempDir('orch-int-steer-once');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  return projectDir;
}

function savedStateWithPendingQuestion(feature: string): WorkflowState {
  let state = createInitialState(feature);
  state = transition(state, { type: 'START' });
  return {
    ...state,
    pendingPlannerConversation: {
      call: 'plan',
      text: 'Which module should the plan cover?',
      questions: [],
      answers: [],
      answered: false,
    },
  };
}

describe('a steer that resumes a run is recorded exactly once', { timeout: 90_000 }, () => {
  it('answers a pending planner question through the call loop and publishes one user message', async () => {
    const projectDir = setupProject();
    const sessionId = 'sess-steer-once';
    const feature = 'resume with a steer';
    const steer = 'use the cached parser';
    const targetFile = 'src/steered.ts';
    const events: EngineEvent[] = [];

    const task = makeTask({
      id: 'T001',
      action: 'create',
      suggestedFiles: [targetFile],
      title: 'Create steered module',
      description: 'Create the steered module after the run resumes.',
      implementationSteps: ['Create src/steered.ts.'],
      tests: ['src/steered.ts exists'],
      scope: { inBounds: [targetFile], outOfBounds: ['unrelated files'] },
      evidence: ['workflow_complete event is emitted after the steered task'],
      typeDefs: 'export const steered = true;',
    });

    const typed = scriptedTypedCall([planFromTasks([task])]);
    const planner = makePlanner({ typedCall: typed.typedCall });
    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi.fn().mockImplementation(async (opts: ImplementerOptions) => {
        mkdirSync(join(opts.projectDir, 'src'), { recursive: true });
        writeFileSync(join(opts.projectDir, targetFile), 'export const steered = true;\n', 'utf-8');
        return {
          success: true,
          output: 'created steered module',
          usage: { inputTokens: 30, outputTokens: 10 },
        };
      }),
    });

    const resumeState = savedStateWithPendingQuestion(feature);
    saveState({ projectDir, sessionId }, resumeState);
    const config = parsePreparedConfig(
      makeConfig({
        implementer: {
          kind: 'agent',
          command: 'node',
          model: 'cheap-direct-agent',
          contextLength: 4096,
        },
        validation: { endChecks: false, testCommand: 'noop' },
        workflow: {
          approve: 'none',
          maxRetries: 1,
        },
      }),
    );
    const preparationId = 'steer-once-preparation';
    const active = {
      version: 1 as const,
      sessionId,
      generation: '9a999999-9999-4999-8999-999999999999',
    };
    const prepared: PreparedExecution = {
      purpose: 'resume',
      config,
      preparationId,
      report: {
        generatedAt: '2026-08-04T00:00:00.000Z',
        projectDir,
        status: 'ready',
        counts: { ok: 2, info: 0, warning: 0, blocker: 0 },
        nextAction: { kind: 'continue', label: 'Continue', reason: 'Ready' },
        sections: [],
        metadata: {},
      },
      gates: [
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
      ],
      session: { kind: 'existing', ref: { projectDir, sessionId }, active },
      runtime: {
        feature,
        resumeState,
        allowRepoRunners: false,
        allowHooks: false,
      },
    };

    const summary = await runTrackedWorkflow({
      prepared,
      savedState: resumeState,
      steer,
      callbacks: makeCallbacks().callbacks,
      sinks: TEST_WORKFLOW_SINKS,
      _planner: planner,
      _implementer: implementer,
      _eventSink: (event) => events.push(event),
    });

    // The re-entry itself stays silent — the pending question owns the steer — and the
    // call loop records the answer once when it consumes the seed.
    const userMessages = events.filter((event) => event.type === 'user_message');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]).toMatchObject({ type: 'user_message', phase: 'planning', text: steer });

    expect(typed.prompts).toHaveLength(1);
    expect(typed.prompts[0]?.split(steer)).toHaveLength(2);

    const log = readFileSync(
      join(projectDir, '.splitbrief', 'sessions', sessionId, 'session.jsonl'),
      'utf-8',
    );
    const steerRows = log
      .split('\n')
      .filter((line) => line.includes('"kind":"message"') && line.includes(JSON.stringify(steer)));
    expect(steerRows).toHaveLength(1);
    expect(summary.totalTasks).toBe(1);
    expect(events.map((event) => event.type)).toContain('workflow_complete');
  });

  // A typed answer cut mid-call is not a document to continue, so the session asks again with the
  // steer and leaves the partial out.
  it('hands a stateless planner the cut partial and the steer once each', async () => {
    const projectDir = setupProject();
    const ref = { projectDir, sessionId: 'sess-steer-partial-once' };
    const partial = 'PARTIAL-SENTINEL half a brief';
    const steer = 'STEER-SENTINEL keep it small';
    const cut = transition(
      transition({ ...createInitialState('cut mid-step'), mode: 'quick' }, { type: 'START' }),
      {
        type: 'INTERRUPT_STEP',
        step: { kind: 'planner', call: 'tasks' },
        source: 'user',
        cut: 'mid-step',
      },
    );
    saveState(ref, cut);
    appendEngineEvent(ref, {
      type: 'runner_call_started',
      ts: Date.now(),
      phase: 'planning',
      callId: 'planner-tasks-1',
      role: 'planner',
      backendKind: 'cli',
    });
    appendMessage(ref, { role: 'assistant', phase: 'planning', text: partial, interrupted: true });
    const prompts: string[] = [];
    const planner = createPlannerBase({
      invokePlan: async ({ prompt }) => {
        prompts.push(prompt);
        return makeRunnerCallResult({
          status: 'completed',
          text: JSON.stringify({
            result: {
              kind: 'questions',
              questions: [{ id: 'module', text: 'Which module?', choices: null, default: 'src' }],
            },
          }),
        });
      },
      invokeEscalate: async () => makeRunnerCallResult({ status: 'completed', text: '' }),
      isAvailable: async () => true,
      capabilities: makePlanner().capabilities,
    });

    await runTrackedWorkflow({
      prepared: makePreparedExecution({
        ...ref,
        feature: cut.feature,
        config: makeConfig({ workflow: {} }),
        resumeState: cut,
        active: reactivateExistingSession(ref),
      }),
      steer,
      callbacks: makeCallbacks().callbacks,
      sinks: TEST_WORKFLOW_SINKS,
      _planner: planner,
      _implementer: makeImplementer(),
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.split('PARTIAL-SENTINEL')).toHaveLength(2);
    expect(prompts[0]?.split('STEER-SENTINEL')).toHaveLength(2);
  });
});
