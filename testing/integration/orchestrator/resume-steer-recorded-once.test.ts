import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInitialState, transition } from '../../../src/core/state/machine.js';
import { saveState } from '../../../src/core/state/persistence.js';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import type { ImplementerOptions } from '../../../src/engine/implementers/types.js';
import type { RunPhaseInput } from '../../../src/engine/planners/types.js';
import {
  makeCallbacks,
  makeImplementer,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makePhaseCallResult } from '#testing/helpers/factories/phase-call.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { TEST_WORKFLOW_SINKS } from '#testing/helpers/orchestrator-context.js';
import { executableReceipt } from '#testing/helpers/custom-command-based.js';
import {
  parsePreparedConfig,
  type PreparedExecution,
} from '../../../src/engine/runners/prepared-execution.js';

const dirs: string[] = [];

beforeEach(() => resetAllStores());

afterEach(() => {
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
  state = transition(state, { type: 'RESEARCH_DONE' });
  state = transition(state, { type: 'SPEC_DONE' });
  state = transition(state, { type: 'APPROVE_SPEC' });
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
      file: targetFile,
      title: 'Create steered module',
      description: 'Create the steered module after the run resumes.',
      implementationSteps: ['Create src/steered.ts.'],
      tests: ['src/steered.ts exists'],
      scope: { inBounds: [targetFile], outOfBounds: ['unrelated files'] },
      evidence: ['workflow_complete event is emitted after the steered task'],
      typeDefs: 'export const steered = true;',
    });

    const planner = makePlanner({
      runPhase: vi.fn(async ({ call }: RunPhaseInput) =>
        makePhaseCallResult({
          call,
          usage: { inputTokens: 100, outputTokens: 60 },
          ...(call === 'tasks' ? { tasks: [task] } : {}),
        }),
      ),
    });
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
        validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
        workflow: {
          mode: 'standard',
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

    const summary = await runWorkflow({
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

    const planCall = vi
      .mocked(planner.runPhase)
      .mock.calls.map((call) => call[0])
      .find((input) => input.call === 'plan');
    expect(planCall?.inputs.promptSuffix).toContain(steer);

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
});
