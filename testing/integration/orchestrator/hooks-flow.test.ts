import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeCallbacks } from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { TASK_MARKDOWN, CODE_RESPONSE } from '#testing/helpers/faux/shell-runner.js';
import { TEST_WORKFLOW_SINKS } from '#testing/helpers/orchestrator-context.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import type { HooksConfig } from '../../../src/core/schemas/hooks.js';

const DENY_PRE_TASK_HOOKS: HooksConfig = {
  pre_task: [
    {
      kind: 'command',
      command: 'node',
      args: [
        '-e',
        'process.stdout.write(JSON.stringify({decision:"deny",message:"blocked by test"}))',
      ],
      timeout_ms: 5000,
      on_failure: 'block',
    },
  ],
};

const dirs: string[] = [];

beforeEach(() => resetAllStores());
afterEach(() => {
  while (dirs.length) cleanupTempDir(dirs.pop() as string);
});

function postTaskMarkerHooks(projectDir: string): HooksConfig {
  const marker = join(projectDir, 'post-task-hook.txt');
  return {
    post_task: [
      {
        kind: 'command',
        command: 'node',
        args: [
          '-e',
          `const input=require('node:fs').readFileSync(0,'utf8');const {event}=JSON.parse(input);require('node:fs').writeFileSync(${JSON.stringify(marker)}, event.taskId);`,
        ],
        timeout_ms: 5000,
        on_failure: 'warn',
      },
    ],
  };
}

describe('hooks integration flow', { timeout: 90_000 }, () => {
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
      allowHooks: true,
      allowRepoRunners: true,
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

  it('post_task hook writes the substituted task id to a project marker', async () => {
    const projectDir = createTempDir('orch-int-hooks-post-task');
    dirs.push(projectDir);
    createTestGitRepo(projectDir);
    const marker = join(projectDir, 'post-task-hook.txt');

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
      hooks: postTaskMarkerHooks(projectDir),
    });

    await runWorkflow({
      feature: 'add foo',
      projectDir,
      config,
      callbacks,
      sinks: TEST_WORKFLOW_SINKS,
      allowHooks: true,
      allowRepoRunners: true,
    });

    await vi.waitFor(
      async () => {
        const payload = await readFile(marker, 'utf8');
        expect(payload).toBe('T001');
      },
      { timeout: 5_000, interval: 20 },
    );
  }, 90_000);
});
