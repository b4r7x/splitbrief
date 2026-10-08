import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInitialState, transition } from '../../../src/core/state/machine.js';
import { loadState, saveState } from '../../../src/core/state/persistence.js';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import type { ImplementerOptions } from '../../../src/engine/implementers/types.js';
import {
  makeCallbacks,
  makeImplementer,
  makePlanner,
  runWorkspaceDir,
} from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { planFromTasks, scriptedTypedCall } from '#testing/helpers/typed-planner.js';
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
  const projectDir = createTempDir('orch-int-resume-direct');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  return projectDir;
}

function savedPlanningContinuationState(feature: string): WorkflowState {
  let state = createInitialState(feature);
  state = transition(state, { type: 'START' });
  return { ...state, awaitingContinue: true };
}

describe('resume planning continuation with a direct-writing implementer', {
  timeout: 90_000,
}, () => {
  it('re-enters planning, runs the direct implementer in a staged project, and completes the workflow', async () => {
    const projectDir = setupProject();
    const sessionId = 'sess-resume-planning-direct';
    const feature = 'resume a paused planning turn';
    const targetFile = 'src/resumed.ts';
    const implementation = 'export const resumed = "from-staged-agent";\n';
    const events: EngineEvent[] = [];

    const task = makeTask({
      id: 'T001',
      action: 'create',
      suggestedFiles: [targetFile],
      title: 'Create resumed module',
      description: 'Create the resumed module after session continuation.',
      implementationSteps: ['Create src/resumed.ts with the resumed export.'],
      tests: ['src/resumed.ts exports the resumed marker'],
      scope: { inBounds: [targetFile], outOfBounds: ['unrelated files'] },
      evidence: ['workflow_complete event is emitted after the resumed task'],
      typeDefs: 'export const resumed: string',
    });

    const typed = scriptedTypedCall([planFromTasks([task])]);
    const planner = makePlanner({ typedCall: typed.typedCall });
    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi.fn().mockImplementation(async (opts: ImplementerOptions) => {
        expect(opts.projectDir).not.toBe(projectDir);
        expect(existsSync(join(projectDir, targetFile))).toBe(false);
        mkdirSync(join(opts.projectDir, 'src'), { recursive: true });
        writeFileSync(join(opts.projectDir, targetFile), implementation, 'utf-8');
        return {
          success: true,
          output: 'created resumed module',
          usage: { inputTokens: 40, outputTokens: 20 },
        };
      }),
    });

    const resumeState = savedPlanningContinuationState(feature);
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
    const preparationId = 'resume-planning-direct-preparation';
    const active = {
      version: 1 as const,
      sessionId,
      generation: '8a888888-8888-4888-8888-888888888888',
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
      callbacks: makeCallbacks().callbacks,
      sinks: TEST_WORKFLOW_SINKS,
      _planner: planner,
      _implementer: implementer,
      _eventSink: (event) => events.push(event),
    });

    // The run was parked inside the old planning chain, so it continues on one planning session.
    expect(typed.prompts).toHaveLength(1);
    expect(implementer.implement).toHaveBeenCalledTimes(1);
    expect(
      readFileSync(join(runWorkspaceDir({ projectDir, sessionId }), targetFile), 'utf-8'),
    ).toBe(implementation);
    expect(summary.totalTasks).toBe(1);
    expect(summary.completedByLocal).toBe(1);
    expect(loadState({ projectDir, sessionId })).toMatchObject({
      phase: 'complete',
      awaitingContinue: false,
    });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'workflow_resumed',
        'tasks_planned',
        'task_completed',
        'workflow_complete',
      ]),
    );
  });
});
