import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeCallbacks,
  makeImplementer,
  makeBusRecorder,
} from '#testing/helpers/orchestrator-factories.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { makeImplStateWithMetadata as implementingState } from '#testing/helpers/factories/workflow-state.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext as makeWorkflowContext,
  setupTaskProject as setupProject,
} from '#testing/helpers/orchestrator-task-context.js';
import { loadState } from '../../../core/state/persistence.js';
import { CONFIRM_PHRASE } from '../../../core/approval/types.js';
import type { ImplementerOptions } from '../../implementers/types.js';
import { createImplementerBase } from '../../implementers/pipeline/run.js';
import { createValidator } from '../validation/run.js';
import { runSingleTask } from './step.js';

afterEach(cleanupTaskProjects);

describe('runSingleTask — user edits', () => {
  it('denied rollback does not erase a clean-at-start file edited during approval', async () => {
    const { projectDir, sessionId } = setupProject({ '.env.local': 'export const v = 1;\n' });

    const task = makeTask({
      id: 'T001',
      action: 'modify',
      file: 'src/main.ts',
      scope: { inBounds: ['src/main.ts'] },
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        writeFileSync(join(projectDir, '.env.local'), 'export const v = 99; // implementer\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const concurrentUserEdit = 'export const v = 3; // concurrent user edit\n';
    const callbacks = {
      ...makeCallbacks().callbacks,
      onTieredApproval: vi.fn().mockImplementation(async () => {
        writeFileSync(join(projectDir, '.env.local'), concurrentUserEdit);
        return { decision: 'deny', reason: 'out of scope' };
      }),
    };
    const { bus, events } = makeBusRecorder();

    await runSingleTask({
      wctx: makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        bus,
        config: makeConfig({
          approval: {
            enabled: true,
            feedRejectionsToPlanner: false,
          },
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
          workflow: { maxRetries: 2 },
        }),
      }),
      task,
      index: 0,
      totalTasks: 1,
      state,
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(readFileSync(join(projectDir, '.env.local'), 'utf-8')).toBe(concurrentUserEdit);
    expect(events.find((event) => event.type === 'warning')).toMatchObject({
      type: 'warning',
      message: expect.stringContaining('rollback skipped files changed during approval'),
    });
  });

  it('denied direct write leaves user edits made during approval and drops staged implementer output', async () => {
    const { projectDir, sessionId } = setupProject({ '.env.local': 'export const v = 1;\n' });

    const task = makeTask({
      id: 'T001',
      action: 'modify',
      file: 'src/main.ts',
      scope: { inBounds: ['src/main.ts'] },
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi.fn().mockImplementation(async ({ projectDir: runDir }: ImplementerOptions) => {
        writeFileSync(join(runDir, '.env.local'), 'export const v = 99; // implementer\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const concurrentUserEdit = 'export const v = 3; // concurrent user edit\n';
    const callbacks = {
      ...makeCallbacks().callbacks,
      onTieredApproval: vi.fn().mockImplementation(async () => {
        writeFileSync(join(projectDir, '.env.local'), concurrentUserEdit);
        return { decision: 'deny', reason: 'out of scope' };
      }),
    };
    const { bus } = makeBusRecorder();

    await runSingleTask({
      wctx: makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        bus,
        config: makeConfig({
          approval: {
            enabled: true,
            feedRejectionsToPlanner: false,
          },
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
          workflow: { maxRetries: 2 },
        }),
      }),
      task,
      index: 0,
      totalTasks: 1,
      state,
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(readFileSync(join(projectDir, '.env.local'), 'utf-8')).toBe(concurrentUserEdit);
  });

  it('approved direct write does not promote staged output over user edits made during approval', async () => {
    const { projectDir, sessionId } = setupProject({ '.env.local': 'export const v = 1;\n' });

    const task = makeTask({
      id: 'T001',
      action: 'modify',
      file: 'src/main.ts',
      scope: { inBounds: ['src/main.ts'] },
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi.fn().mockImplementation(async ({ projectDir: runDir }: ImplementerOptions) => {
        writeFileSync(join(runDir, '.env.local'), 'export const v = 99; // implementer\n');
        return { success: true, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const concurrentUserEdit = 'export const v = 3; // concurrent user edit\n';
    const callbacks = {
      ...makeCallbacks().callbacks,
      onTieredApproval: vi.fn().mockImplementation(async () => {
        writeFileSync(join(projectDir, '.env.local'), concurrentUserEdit);
        return { decision: 'confirm', phrase: CONFIRM_PHRASE, reason: 'ok' };
      }),
    };
    const runValidation = vi.fn().mockResolvedValue([]);
    const { bus, events } = makeBusRecorder();

    const result = await runSingleTask({
      wctx: makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        bus,
        config: makeConfig({
          approval: {
            enabled: true,
            feedRejectionsToPlanner: false,
          },
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

    expect(readFileSync(join(projectDir, '.env.local'), 'utf-8')).toBe(concurrentUserEdit);
    expect(runValidation).not.toHaveBeenCalled();
    expect(result.currentTaskIndex).toBe(0);
    expect(
      events.find(
        (event) =>
          event.type === 'paused_external_changes' &&
          event.conflict?.kind === 'changed-during-approval-promotion',
      ),
    ).toMatchObject({
      type: 'paused_external_changes',
      selectedAction: 'pause',
      conflict: {
        kind: 'changed-during-approval-promotion',
        files: ['.env.local'],
        affectedTaskIds: ['T001'],
        safeToContinue: false,
      },
    });
    expect(events.find((event) => event.type === 'error')).toMatchObject({
      type: 'error',
      message: expect.stringContaining('promotion blocked'),
    });
  });

  it('extracted-code approval races ask for user-edit resolution instead of retrying', async () => {
    const { projectDir, sessionId } = setupProject();

    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'package.json'), 'export const value = "before";\n');

    const task = makeTask({
      id: 'T001',
      action: 'modify',
      file: 'package.json',
      scope: { inBounds: ['package.json'] },
    });
    const state = implementingState([task]);

    const implementer = createImplementerBase({
      extractsCode: true,
      invoke: vi.fn().mockResolvedValue(
        makeRunnerCallResult({
          status: 'completed',
          text: '```ts\nexport const value = "implementer";\n```',
          usage: { inputTokens: 10, outputTokens: 5 },
        }),
      ),
    });
    const userEdit = 'export const value = "user";\n';
    const onUserEditConflict = vi.fn().mockResolvedValue('pause');
    let approvalCalls = 0;
    const callbacks = {
      ...makeCallbacks().callbacks,
      onTieredApproval: vi.fn().mockImplementation(async () => {
        approvalCalls++;
        if (approvalCalls === 1) {
          writeFileSync(join(projectDir, 'package.json'), userEdit);
        }
        return { decision: 'confirm', phrase: CONFIRM_PHRASE, reason: 'ok' };
      }),
      onUserEditConflict,
    };
    const runValidation = vi.fn().mockResolvedValue([]);
    const { bus, events } = makeBusRecorder();

    const result = await runSingleTask({
      wctx: makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        bus,
        config: makeConfig({
          approval: {
            enabled: true,
            feedRejectionsToPlanner: false,
          },
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

    expect(readFileSync(join(projectDir, 'package.json'), 'utf-8')).toBe(userEdit);
    expect(runValidation).not.toHaveBeenCalled();
    expect(result.currentTaskIndex).toBe(0);
    expect(onUserEditConflict).not.toHaveBeenCalled();
    expect(result.pendingRecovery).toMatchObject({
      reason: 'approval-promotion-conflict',
      taskId: 'T001',
      files: ['package.json'],
      availableActions: ['skip-current-task', 'pause-run', 'end-run'],
    });
    expect(loadState({ projectDir, sessionId })?.pendingRecovery).toMatchObject({
      reason: 'approval-promotion-conflict',
      taskId: 'T001',
    });
    expect(events.find((event) => event.type === 'paused_external_changes')).toMatchObject({
      type: 'paused_external_changes',
      selectedAction: 'pause',
      conflict: {
        kind: 'changed-during-approval-promotion',
        files: ['package.json'],
      },
    });
  });
});
