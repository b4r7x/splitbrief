import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeCallbacks } from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { TASK_MARKDOWN, CODE_RESPONSE } from '#testing/helpers/faux/shell-runner.js';
import { TEST_WORKFLOW_SINKS } from '#testing/helpers/orchestrator-context.js';
import { persistReadyExecutionState } from '#testing/helpers/persisted-execution.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';

const dirs: string[] = [];

beforeEach(() => resetAllStores());
afterEach(() => {
  while (dirs.length) cleanupTempDir(dirs.pop() as string);
});

describe('EventBus end-to-end flow', { timeout: 90_000 }, () => {
  it('publishes a coherent event sequence for a one-task quick-mode workflow', async () => {
    const projectDir = createTempDir('orch-int-bus-flow');
    dirs.push(projectDir);
    createTestGitRepo(projectDir);

    const recorded: EngineEvent[] = [];
    const { callbacks } = makeCallbacks();

    const config = makeConfig({
      planner: {
        kind: 'shell',
        command: 'node',
        args: ['-e', `process.stdout.write(${JSON.stringify(TASK_MARKDOWN)})`],
      },
      implementer: {
        kind: 'shell',
        command: 'node',
        args: ['-e', `process.stdout.write(${JSON.stringify(CODE_RESPONSE)})`],
        model: 'fake-model',
        contextLength: 4096,
        temperature: 0,
      },
      validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
      workflow: { mode: 'quick', persistTranscript: false, maxRetries: 1 },
    });
    const feature = 'add foo';
    const sessionId = 'event-bus-flow-session';
    const preparationId = 'event-bus-flow-preparation';
    const active = {
      version: 1 as const,
      sessionId,
      generation: '3a333333-3333-4333-8333-333333333333',
    };
    const resumeState = persistReadyExecutionState(
      { projectDir, sessionId },
      {
        ...createInitialState(feature),
        phase: 'implementing',
        mode: 'quick',
        plannerTool: 'shell',
        implementerTool: 'shell',
        tasks: [
          makeTask({
            scope: {
              inBounds: ['Modify only `src/hello.ts`.'],
              outOfBounds: ['Do not touch anything outside the task file.'],
            },
            evidence: ['brief-quality.json confirms the task brief is complete'],
            typeDefs: 'type HelloModule = { greeting: string }',
          }),
        ],
      },
    );
    const prepared = makePreparedExecution({
      projectDir,
      sessionId,
      feature,
      config,
      preparationId,
      active,
      resumeState,
      purpose: 'new-workflow',
      allowHooks: true,
      gates: () => [
        {
          kind: 'shell',
          slot: { role: 'planner' },
          preparationId,
          command: { kind: 'validated-config' },
        },
        {
          kind: 'shell',
          slot: { role: 'implementer', profile: 'default' },
          preparationId,
          command: { kind: 'validated-config' },
        },
      ],
    });

    await runWorkflow({
      prepared,
      callbacks,
      sinks: TEST_WORKFLOW_SINKS,
      _eventSink: (e) => recorded.push(e),
    });

    const types = recorded.map((e) => e.type);

    // The permit-gated resumed execution starts with workflow_resumed and
    // immediately runs the one task without an approval-gate event.
    expect(types).toContain('workflow_resumed');
    expect(types).toContain('workflow_config');
    expect(types).toContain('task_started');
    expect(types).toContain('implementer_generate_running');
    expect(types).toContain('implementer_generate_done');
    expect(types).toContain('task_completed');
    expect(types).toContain('all_tasks_done');
    expect(types).toContain('workflow_complete');

    const idx = (t: EngineEvent['type']) => types.indexOf(t);

    expect(idx('workflow_resumed')).toBeLessThan(idx('workflow_config'));
    expect(idx('workflow_config')).toBeLessThan(idx('task_started'));
    expect(idx('task_started')).toBeLessThan(idx('implementer_generate_running'));
    expect(idx('implementer_generate_running')).toBeLessThan(idx('implementer_generate_done'));
    expect(idx('implementer_generate_done')).toBeLessThan(idx('task_completed'));
    expect(idx('task_completed')).toBeLessThan(idx('all_tasks_done'));
    expect(idx('all_tasks_done')).toBeLessThan(idx('workflow_complete'));
  }, 90_000);
});
