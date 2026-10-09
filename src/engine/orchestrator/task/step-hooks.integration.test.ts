import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeCallbacks,
  makeImplementer,
  makeBusRecorder,
  openRunWorkspace,
} from '#testing/helpers/orchestrator-factories.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeImplStateWithMetadata as implementingState } from '#testing/helpers/factories/workflow-state.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext as makeWorkflowContext,
  setupTaskProject as setupProject,
} from '#testing/helpers/orchestrator-task-context.js';
import { processError } from '../../../lib/process/errors.js';
import * as commandRunner from '../../../lib/process/spawn/run-command.js';
import type { Check } from '../../../core/schemas/task.js';
import { runSingleTask } from './step.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import type { HooksConfig } from '../../../core/schemas/hooks.js';
import { markHooksConfigTrusted } from '../../../core/hooks/trust.js';

// The pre_validation hook gates the brief checks: a brief with no check runs no hook.
const BRIEF_CHECKS: Check[] = [{ id: 'K1', kind: 'cmd', value: 'tsc --noEmit', required: true }];

let trustHome: ReturnType<typeof useTrustHome>;

beforeEach(() => {
  trustHome = useTrustHome('run-single-task-hooks-trust-home');
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTaskProjects();
  trustHome.restore();
});

describe('runSingleTask — pre_validation hooks', () => {
  it('skips the task (not silently stops) when a pre_validation hook denies', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({
      id: 'T001',
      action: 'create',
      suggestedFiles: ['src/hello.ts'],
      scope: { inBounds: ['src/hello.ts'] },
      checks: BRIEF_CHECKS,
    });
    const state = implementingState([task]);

    writeFileSync(
      join(projectDir, 'deny-validation.mjs'),
      [
        "import { readFileSync, writeFileSync } from 'node:fs';",
        "writeFileSync('pre-validation-payload.json', readFileSync(0, 'utf8'));",
        "console.log(JSON.stringify({ decision: 'deny', message: 'policy: validation gated' }));",
        '',
      ].join('\n'),
    );

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async ({ projectDir }: { projectDir: string }) => {
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(join(projectDir, 'src/hello.ts'), 'export const hello = "world";\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const runCommand = vi
      .spyOn(commandRunner, 'runCommand')
      .mockResolvedValue({ stdout: '', stderr: '', code: 0 });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const hooks: HooksConfig = {
      pre_validation: [
        {
          kind: 'command',
          command: 'node',
          args: ['deny-validation.mjs'],
          timeout_ms: 30_000,
          on_failure: 'warn',
        },
      ],
    };
    markHooksConfigTrusted(projectDir, hooks);

    const wctx = await openRunWorkspace(
      makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        bus,
        config: makeConfig({
          workflow: { review: 'task' },

          hooks,
        }),
      }),
    );
    const result = await runSingleTask({
      wctx,
      task,
      index: 0,
      totalTasks: 1,
      state,
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(runCommand).not.toHaveBeenCalled();
    const payload = JSON.parse(
      readFileSync(join(projectDir, 'pre-validation-payload.json'), 'utf8'),
    ) as { event: Record<string, unknown> };
    expect(payload.event).toMatchObject({ type: 'validate', taskId: 'T001', status: 'running' });
    expect(payload.event).not.toHaveProperty('stages');
    expect(result.tasks[0]?.status).toBe('skipped');
    expect(result.currentTaskIndex).toBe(1);
    expect(result.pendingRecovery).toBeUndefined();
    expect(events.find((e) => e.type === 'task_skipped')).toMatchObject({
      type: 'task_skipped',
      taskId: 'T001',
      reason: 'policy: validation gated',
    });
    expect(events.find((e) => e.type === 'task_completed')).toBeUndefined();
    expect(existsSync(join(wctx.workspaceDir, 'src/hello.ts'))).toBe(false);
    expect(
      events.find(
        (e) =>
          e.type === 'warning' &&
          e.message.includes('unvalidated task change(s) after pre_validation denied'),
      ),
    ).toBeDefined();

    const ledger = readEvidenceLedger({ projectDir, sessionId });
    expect(ledger?.tasks.find((entry) => entry.id === 'T001')).toMatchObject({
      id: 'T001',
      status: 'skipped',
    });
  });

  it('ends the retry ladder on the skip when the hook denies a retry attempt', async () => {
    const { projectDir, sessionId } = setupProject();
    const first = makeTask({
      id: 'T001',
      action: 'create',
      suggestedFiles: ['src/hello.ts'],
      scope: { inBounds: ['src/hello.ts'] },
      checks: BRIEF_CHECKS,
    });
    const second = makeTask({ id: 'T002', suggestedFiles: ['src/other.ts'] });
    const state = implementingState([first, second]);

    const calls = join(projectDir, 'hook-calls');
    writeFileSync(
      join(projectDir, 'deny-second-validation.mjs'),
      [
        "import { existsSync, writeFileSync } from 'node:fs';",
        `const calls = ${JSON.stringify(calls)};`,
        "if (existsSync(calls)) console.log(JSON.stringify({ decision: 'deny', message: 'policy: retry gated' }));",
        "else writeFileSync(calls, '1');",
        '',
      ].join('\n'),
    );
    const write =
      (content: string) =>
      async ({ projectDir: runDir }: { projectDir: string }) => {
        mkdirSync(join(runDir, 'src'), { recursive: true });
        writeFileSync(join(runDir, 'src/hello.ts'), content);
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      };
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(write('export const hello = 1;\n')),
      retry: vi.fn().mockImplementation(write('export const hello = 2;\n')),
    });
    const runCommand = vi.spyOn(commandRunner, 'runCommand').mockRejectedValue(
      processError.exitCode({
        command: 'tsc',
        code: 2,
        stderr: 'src/hello.ts(1,1): error TS2322',
        output: '',
      }),
    );
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const hooks: HooksConfig = {
      pre_validation: [
        {
          kind: 'command',
          command: 'node',
          args: ['deny-second-validation.mjs'],
          timeout_ms: 30_000,
          on_failure: 'warn',
        },
      ],
    };
    markHooksConfigTrusted(projectDir, hooks);

    const wctx = await openRunWorkspace(
      makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        bus,
        config: makeConfig({
          workflow: { review: 'task' },
          hooks,
        }),
      }),
    );
    const result = await runSingleTask({
      wctx,
      task: first,
      index: 0,
      totalTasks: 2,
      state,
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(implementer.retry).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(result.tasks.map((task) => task.status)).toEqual(['skipped', 'pending']);
    expect(result.currentTaskIndex).toBe(1);
    expect(result.pendingRecovery).toBeUndefined();
    expect(events.filter((e) => e.type === 'task_completed')).toEqual([]);
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(existsSync(join(wctx.workspaceDir, 'src/hello.ts'))).toBe(false);
    const ledger = readEvidenceLedger({ projectDir, sessionId });
    expect(ledger?.tasks.find((entry) => entry.id === 'T001')).toMatchObject({
      status: 'skipped',
    });
  });
});
