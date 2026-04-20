import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeCallbacks } from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/run.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import type { WorkflowSinks } from '../../../src/engine/orchestrator/types.js';

const SINKS: WorkflowSinks = { setAbortHandler: () => {}, setQueueHandler: () => {} };

const TASK_MARKDOWN = [
  '---',
  'id: T001',
  'title: Create hello module',
  'action: create',
  'file: src/hello.ts',
  '---',
  '',
  '### Description',
  'Create a hello world module',
].join('\n');

const CODE_RESPONSE = [
  '```typescript',
  'export function hello() { return "hello"; }',
  '```',
].join('\n');

const dirs: string[] = [];

beforeEach(() => resetAllStores());
afterEach(() => { while (dirs.length) cleanupTempDir(dirs.pop() as string); });

describe('hooks integration flow', () => {
  it('pre_task hook deny causes task_skipped and no task_completed', async () => {
    const projectDir = createTempDir('orch-int-hooks-pre-task');
    dirs.push(projectDir);
    createTestGitRepo(projectDir);

    const recorded: EngineEvent[] = [];
    const { callbacks } = makeCallbacks({ onExternalChanges: async () => true });

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

    // Add a pre_task hook that unconditionally denies (node prints deny JSON then exits 0)
    (config as Record<string, unknown>)['hooks'] = {
      pre_task: [{
        command: 'node',
        args: ['-e', 'process.stdout.write(JSON.stringify({decision:"deny",message:"blocked by test"}))'],
        timeout_ms: 5000,
        on_failure: 'block',
      }],
    };

    await runWorkflow({
      feature: 'add foo',
      projectDir,
      config,
      callbacks,
      sinks: SINKS,
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
    const { callbacks } = makeCallbacks({ onExternalChanges: async () => true });

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

    // Add a post_task hook that allows (echo exits 0)
    (config as Record<string, unknown>)['hooks'] = {
      post_task: [{
        command: 'echo',
        args: ['hook-fired'],
        timeout_ms: 5000,
        on_failure: 'warn',
      }],
    };

    await runWorkflow({
      feature: 'add foo',
      projectDir,
      config,
      callbacks,
      sinks: SINKS,
      _eventSink: (e) => recorded.push(e),
    });

    const types = recorded.map((e) => e.type);

    expect(types).toContain('task_completed');
    expect(types).toContain('workflow_complete');

    const completedIdx = types.indexOf('task_completed');
    const completeIdx = types.indexOf('workflow_complete');
    expect(completedIdx).toBeLessThan(completeIdx);
  });
});
