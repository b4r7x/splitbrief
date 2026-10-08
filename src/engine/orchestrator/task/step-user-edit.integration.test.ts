import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeCallbacks,
  makeImplementer,
  makeBusRecorder,
  openRunWorkspace,
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
      suggestedFiles: ['src/main.ts'],
      scope: { inBounds: ['src/main.ts'] },
    });
    const state = implementingState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async ({ projectDir }: ImplementerOptions) => {
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
          workflow: { review: 'task' },

          approval: {
            feedRejectionsToPlanner: false,
          },
          validation: { typecheck: false, lint: false, test: true, testCommand: 'noop' },
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
    expect(events.find((event) => event.type === 'error')).toMatchObject({
      type: 'error',
      message: expect.stringContaining("discarded this attempt's writes to .env.local"),
    });
  });

  it('denied direct write leaves user edits made during approval and drops staged implementer output', async () => {
    const { projectDir, sessionId } = setupProject({ '.env.local': 'export const v = 1;\n' });

    const task = makeTask({
      id: 'T001',
      action: 'modify',
      suggestedFiles: ['src/main.ts'],
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
          workflow: { review: 'task' },

          approval: {
            feedRejectionsToPlanner: false,
          },
          validation: { typecheck: false, lint: false, test: true, testCommand: 'noop' },
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

  it('approved direct write stays in the workspace and a checkout edit made during approval stays in the checkout', async () => {
    const { projectDir, sessionId } = setupProject({ '.env.local': 'export const v = 1;\n' });

    const task = makeTask({
      id: 'T001',
      action: 'modify',
      suggestedFiles: ['src/main.ts'],
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
    const { bus } = makeBusRecorder();

    const wctx = await openRunWorkspace(
      makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        bus,
        config: makeConfig({
          workflow: { review: 'task' },

          approval: {
            feedRejectionsToPlanner: false,
          },
          validation: { typecheck: false, lint: false, test: true, testCommand: 'noop' },
        }),
        validator: { ...createValidator(), runValidation },
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

    expect(readFileSync(join(projectDir, '.env.local'), 'utf-8')).toBe(concurrentUserEdit);
    expect(readFileSync(join(wctx.workspaceDir, '.env.local'), 'utf-8')).toBe(
      'export const v = 99; // implementer\n',
    );
    expect(runValidation).toHaveBeenCalledTimes(1);
    expect(result.tasks[0]?.status).toBe('done');
    expect(result.pendingRecovery).toBeUndefined();
  });

  it('an extracted-code write lands in the workspace while a checkout edit made during approval stays in the checkout', async () => {
    const { projectDir, sessionId } = setupProject();

    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'package.json'), 'export const value = "before";\n');

    const task = makeTask({
      id: 'T001',
      action: 'modify',
      suggestedFiles: ['package.json'],
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
    };
    const runValidation = vi.fn().mockResolvedValue([]);
    const { bus } = makeBusRecorder();

    const wctx = await openRunWorkspace(
      makeWorkflowContext({
        projectDir,
        sessionId,
        callbacks,
        implementer,
        bus,
        config: makeConfig({
          workflow: { review: 'task' },

          approval: {
            feedRejectionsToPlanner: false,
          },
          validation: { typecheck: false, lint: false, test: true, testCommand: 'noop' },
        }),
        validator: { ...createValidator(), runValidation },
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

    expect(readFileSync(join(projectDir, 'package.json'), 'utf-8')).toBe(userEdit);
    expect(readFileSync(join(wctx.workspaceDir, 'package.json'), 'utf-8')).toBe(
      'export const value = "implementer";',
    );
    expect(runValidation).toHaveBeenCalledTimes(1);
    expect(result.tasks[0]?.status).toBe('done');
    expect(result.pendingRecovery).toBeUndefined();
  });
});
