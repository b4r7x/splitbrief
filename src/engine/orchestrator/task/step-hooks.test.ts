import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeCallbacks,
  makeImplementer,
  makeBusRecorder,
} from '#testing/helpers/orchestrator-factories.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeImplStateWithMetadata as implementingState } from '#testing/helpers/factories/workflow-state.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext as makeWorkflowContext,
  setupTaskProject as setupProject,
} from '#testing/helpers/orchestrator-task-context.js';
import { createValidator } from '../validation/run.js';
import { runSingleTask } from './step.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import type { HooksConfig } from '../../../core/schemas/hooks.js';
import { markHooksConfigTrusted } from '../../../core/hooks/trust.js';

let trustHome: ReturnType<typeof useTrustHome>;

beforeEach(() => {
  trustHome = useTrustHome('run-single-task-hooks-trust-home');
});

afterEach(() => {
  cleanupTaskProjects();
  trustHome.restore();
});

describe('runSingleTask — pre_validation hooks', () => {
  it('skips the task (not silently stops) when a pre_validation hook denies', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({
      id: 'T001',
      action: 'create',
      file: 'src/hello.ts',
      scope: { inBounds: ['src/hello.ts'] },
    });
    const state = implementingState([task]);

    writeFileSync(
      join(projectDir, 'deny-validation.mjs'),
      [
        'export default function () {',
        "  return { kind: 'deny', message: 'policy: validation gated' };",
        '}',
      ].join('\n'),
    );

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(join(projectDir, 'src/hello.ts'), 'export const hello = "world";\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const runValidation = vi.fn().mockResolvedValue([]);
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const hooks: HooksConfig = {
      pre_validation: [
        {
          kind: 'module',
          path: 'deny-validation.mjs',
          timeout_ms: 30_000,
          on_failure: 'warn',
        },
      ],
    };
    markHooksConfigTrusted(projectDir, hooks);

    const result = await runSingleTask({
      wctx: makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        bus,
        config: makeConfig({
          hooks,
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
          workflow: { maxRetries: 2 },
        }),
        validator: { ...createValidator(), runValidation },
      }),
      task,
      index: 0,
      totalTasks: 1,
      state,
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(runValidation).not.toHaveBeenCalled();
    expect(result.tasks[0]?.status).toBe('skipped');
    expect(result.currentTaskIndex).toBe(1);
    expect(result.pendingRecovery).toBeUndefined();
    expect(events.find((e) => e.type === 'task_skipped')).toMatchObject({
      type: 'task_skipped',
      taskId: 'T001',
      reason: 'policy: validation gated',
    });
    expect(events.find((e) => e.type === 'task_completed')).toBeUndefined();
    expect(existsSync(join(projectDir, 'src/hello.ts'))).toBe(false);
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
});
