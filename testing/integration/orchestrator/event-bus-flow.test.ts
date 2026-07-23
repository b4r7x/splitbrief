import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeCallbacks } from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { TASK_MARKDOWN, CODE_RESPONSE } from '#testing/helpers/faux/shell-runner.js';
import { TEST_WORKFLOW_SINKS } from '#testing/helpers/orchestrator-context.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';

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
      workflow: { mode: 'quick', commitStrategy: 'none', persistTranscript: false, maxRetries: 1 },
    });

    await runWorkflow({
      feature: 'add foo',
      projectDir,
      config,
      callbacks,
      sinks: TEST_WORKFLOW_SINKS,
      allowHooks: true,
      _eventSink: (e) => recorded.push(e),
    });

    const types = recorded.map((e) => e.type);

    // Quick mode emits plan_approved (not plan_done) — it auto-approves and skips the gate.
    expect(types).toContain('workflow_started');
    expect(types).toContain('workflow_config');
    expect(types).toContain('plan_approved');
    expect(types).toContain('task_started');
    expect(types).toContain('implementer_generate_running');
    expect(types).toContain('implementer_generate_done');
    expect(types).toContain('task_completed');
    expect(types).toContain('all_tasks_done');
    expect(types).toContain('workflow_complete');

    const idx = (t: EngineEvent['type']) => types.indexOf(t);

    // Canonical ordering invariants:
    expect(idx('workflow_started')).toBeLessThan(idx('workflow_config'));
    expect(idx('workflow_config')).toBeLessThan(idx('plan_approved'));
    expect(idx('plan_approved')).toBeLessThan(idx('task_started'));
    expect(idx('task_started')).toBeLessThan(idx('implementer_generate_running'));
    expect(idx('implementer_generate_running')).toBeLessThan(idx('implementer_generate_done'));
    expect(idx('implementer_generate_done')).toBeLessThan(idx('task_completed'));
    expect(idx('task_completed')).toBeLessThan(idx('all_tasks_done'));
    expect(idx('all_tasks_done')).toBeLessThan(idx('workflow_complete'));
  }, 90_000);
});
