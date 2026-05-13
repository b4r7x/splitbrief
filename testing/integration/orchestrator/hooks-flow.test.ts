import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeCallbacks } from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { TASK_MARKDOWN, CODE_RESPONSE } from '#testing/helpers/fixtures/shell-runner.js';
import { TEST_WORKFLOW_SINKS } from '#testing/helpers/orchestrator-context.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/run.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import type { HooksConfig } from '../../../src/core/schemas/hooks.js';

const DENY_PRE_TASK_HOOKS: HooksConfig = {
  pre_task: [{
    kind: 'command',
    command: 'node',
    args: ['-e', 'process.stdout.write(JSON.stringify({decision:"deny",message:"blocked by test"}))'],
    timeout_ms: 5000,
    on_failure: 'block',
  }],
};
const ALLOW_POST_TASK_HOOKS: HooksConfig = {
  post_task: [{
    kind: 'command',
    command: 'echo',
    args: ['hook-fired'],
    timeout_ms: 5000,
    on_failure: 'warn',
  }],
};

const dirs: string[] = [];

beforeEach(() => resetAllStores());
afterEach(() => { while (dirs.length) cleanupTempDir(dirs.pop() as string); });

describe('hooks integration flow', () => {
  it('pre_task hook deny causes task_skipped and no task_completed', async () => {
    const projectDir = createTempDir('orch-int-hooks-pre-task');
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
      hooks: DENY_PRE_TASK_HOOKS,
    });

    await runWorkflow({
      feature: 'add foo',
      projectDir,
      config,
      callbacks,
      sinks: TEST_WORKFLOW_SINKS,
      _eventSink: (e) => recorded.push(e),
    });

    const types = recorded.map((e) => e.type);

    expect(types).toContain('task_skipped');
    expect(types).not.toContain('task_completed');
    expect(types).not.toContain('task_started');

    const skipped = recorded.find((e) => e.type === 'task_skipped');
    expect(skipped).toBeDefined();
    if (skipped && skipped.type === 'task_skipped') {
      expect(skipped.reason).toContain('blocked by test');
    }
  });

  it('post_task hook fires after task_completed', async () => {
    const projectDir = createTempDir('orch-int-hooks-post-task');
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
      hooks: ALLOW_POST_TASK_HOOKS,
    });

    await runWorkflow({
      feature: 'add foo',
      projectDir,
      config,
      callbacks,
      sinks: TEST_WORKFLOW_SINKS,
      _eventSink: (e) => recorded.push(e),
    });

    const types = recorded.map((e) => e.type);

    expect(types).toContain('task_completed');
    expect(types).toContain('workflow_complete');

    const completedIdx = types.indexOf('task_completed');
    const completeIdx = types.indexOf('workflow_complete');
    expect(completedIdx).toBeLessThan(completeIdx);
  }, 20_000);
});
