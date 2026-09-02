import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeCallbacks } from '#testing/helpers/orchestrator-factories.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { makeShellRunnerConfig } from '#testing/helpers/faux/shell-runner.js';
import { TEST_WORKFLOW_SINKS } from '#testing/helpers/orchestrator-context.js';
import { persistReadyExecutionState } from '#testing/helpers/persisted-execution.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import type { HooksConfig } from '../../../src/core/schemas/hooks.js';
import type { Config } from '../../../src/core/schemas/config.js';
import { markHooksConfigTrusted } from '../../../src/core/hooks/trust.js';
import {
  parsePreparedConfig,
  type PreparedExecution,
} from '../../../src/engine/runners/prepared-execution.js';

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
let trustHome: ReturnType<typeof useTrustHome>;

beforeEach(() => {
  trustHome = useTrustHome('hooks-flow-trust-home');
  resetAllStores();
});
afterEach(() => {
  while (dirs.length) cleanupTempDir(dirs.pop() as string);
  trustHome.restore();
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

function preparedExecution(
  projectDir: string,
  feature: string,
  inputConfig: Config,
): PreparedExecution {
  if (inputConfig.hooks !== undefined) markHooksConfigTrusted(projectDir, inputConfig.hooks);
  const config = parsePreparedConfig(inputConfig);
  const sessionId = `hooks-${feature.replaceAll(' ', '-')}`;
  const preparationId = `${sessionId}-preparation`;
  const active = {
    version: 1 as const,
    sessionId,
    generation: '4a444444-4444-4444-8444-444444444444',
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
  return {
    purpose: 'new-workflow',
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
    session: { kind: 'existing', ref: { projectDir, sessionId }, active },
    runtime: { feature, allowRepoRunners: true, allowHooks: true, resumeState },
  };
}

describe('hooks integration flow', { timeout: 90_000 }, () => {
  it('pre_task hook deny causes task_skipped and no task_completed', async () => {
    const projectDir = createTempDir('orch-int-hooks-pre-task');
    dirs.push(projectDir);
    createTestGitRepo(projectDir);

    const recorded: EngineEvent[] = [];
    const { callbacks } = makeCallbacks();

    const config = makeShellRunnerConfig({ hooks: DENY_PRE_TASK_HOOKS });

    await runWorkflow({
      prepared: preparedExecution(projectDir, 'add foo', config),
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

  it('post_task hook writes the substituted task id to a project marker', async () => {
    const projectDir = createTempDir('orch-int-hooks-post-task');
    dirs.push(projectDir);
    createTestGitRepo(projectDir);
    const marker = join(projectDir, 'post-task-hook.txt');

    const { callbacks } = makeCallbacks();

    const config = makeShellRunnerConfig({ hooks: postTaskMarkerHooks(projectDir) });

    await runWorkflow({
      prepared: preparedExecution(projectDir, 'add foo', config),
      callbacks,
      sinks: TEST_WORKFLOW_SINKS,
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
