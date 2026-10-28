import { plainUserMessage } from '../../../core/types/user-input.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConsultAnswer } from '../../../core/schemas/consult.js';
import type { Plan, TaskSpec } from '../../../core/schemas/plan.js';
import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { sessionDir, SESSION_LOG_FILE } from '../../../core/paths.js';
import { createJsonlSink } from '../../events/sinks/jsonl.js';
import type { EngineEvent } from '../../events/types.js';
import { makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import {
  makeBusRecorder,
  makeCallbacks,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeConfig } from '#testing/helpers/validation-fixtures.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import { createValidator } from '../validation/run.js';
import { refreshAndPersistCode } from '../task/refresh-code.js';
import type { OrchestratorCallbacks } from '../types.js';
import { applyConsultAnswer, type ConsultApplyContext } from './apply.js';
import {
  attachedMessage,
  expectCompactMessage,
  expectResumedMessage,
} from '#testing/helpers/user-message.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

const BASE_GREET = 'export const greet = "base";\n';
const ATTEMPT_GREET = 'export const greet = "attempt";\n';
const CONTEXT = 'export const context = true;\n';

function setupRepo(dirsToClean: string[]): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('consult-apply');
  dirsToClean.push(projectDir);
  createTestGitRepo(projectDir, { 'src/greet.ts': BASE_GREET, 'src/context.ts': CONTEXT });
  const sessionId = 'sess-consult-apply';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

const EMPTY_SNAPSHOT: ChangedFilesSnapshot = { head: '', files: [], dirtyFileContents: {} };

function contextFor(
  projectDir: string,
  sessionId: string,
  task: Task,
  plan?: Plan,
  callbacks?: Partial<OrchestratorCallbacks>,
): { ctx: ConsultApplyContext; states: WorkflowState[]; events: EngineEvent[] } {
  const state: WorkflowState = {
    ...transition(createInitialState('Fix the greeting'), { type: 'START' }),
    phase: 'escalating',
    tasks: [task],
    currentTaskIndex: 0,
    attempt: 1,
    ...(plan !== undefined && { plan }),
  };
  saveState({ projectDir, sessionId }, state);
  const { bus, events } = makeBusRecorder();
  const states: WorkflowState[] = [];
  return {
    ctx: {
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      taskStartSnapshot: EMPTY_SNAPSHOT,
      bus,
      config: makeConfig({}),
      validator: createValidator(),
      callbacks: makeCallbacks(callbacks).callbacks,
      sinks: TEST_SINKS,
      state,
      seat: 'plan',
      onStateChange: (next) => states.push(next),
    },
    states,
    events,
  };
}

function guidance(instructions: string, context: string | null): ConsultAnswer {
  return { answer: { diagnosis: 'The task failed', action: 'guidance', instructions, context } };
}

function rewrite(spec: TaskSpec): ConsultAnswer {
  return { answer: { diagnosis: 'The brief was wrong', action: 'rewrite-task', task: spec } };
}

function split(specs: TaskSpec[]): ConsultAnswer {
  return { answer: { diagnosis: 'The brief was too big', action: 'split-task', tasks: specs } };
}

describe('applyConsultAnswer', () => {
  it('delivers an attached file from a structured consult reply and records compact text once', async () => {
    const projectDir = createTempDir('consult-attached-file');
    dirs.push(projectDir);
    const ref = { projectDir, sessionId: 'consult-attached-file' };
    ensureSessionDir(projectDir, ref.sessionId);
    const message = attachedMessage(projectDir);
    const qa = [{ question: 'Which store?', answer: message.displayText }];
    const task = makeTask({ id: 'T003' });
    const { ctx, events } = contextFor(projectDir, ref.sessionId, task, undefined, {
      onPlannerReply: async () => ({ message, qa }),
    });
    ctx.bus.subscribe(createJsonlSink(ref));
    const result = await applyConsultAnswer(
      ctx,
      task,
      {
        answer: {
          action: 'ask-user',
          diagnosis: 'Need context',
          question: 'Which store?',
          whyOnlyUserCanAnswer: 'Only the user has the file',
          choices: null,
          default: null,
        },
      },
      EMPTY_SNAPSHOT,
    );
    expect(result).toMatchObject({
      action: 'guidance',
      instructions: expect.stringContaining('PELICAN-42'),
    });
    expect(events.find((event) => event.type === 'user_message')).toMatchObject({ qa });
    await expectCompactMessage(ref, events, message);
    await expectResumedMessage(ref, message);
  });

  it('returns the guidance for the next attempt without touching the run', async () => {
    const { projectDir, sessionId } = setupRepo(dirs);
    const task = makeTask({
      id: 'T003',
      suggestedFiles: ['src/greet.ts'],
      criteria: ['C1'],
      status: 'failed',
    });
    const { ctx, states, events } = contextFor(projectDir, sessionId, task);
    const attempt = await getChangedFilesSnapshot(projectDir);

    const result = await applyConsultAnswer(
      ctx,
      task,
      guidance('Use the named export.', 'src/context.ts'),
      attempt,
    );

    expect(result).toEqual({
      action: 'guidance',
      instructions: 'Use the named export.',
      context: 'src/context.ts',
    });
    expect(states).toHaveLength(0);
    expect(events.filter((event) => event.type === 'task_replaced')).toHaveLength(0);
  });

  it("hands the planner's own ask-user answer back as guidance", async () => {
    const { projectDir, sessionId } = setupRepo(dirs);
    const task = makeTask({ id: 'T003', suggestedFiles: ['src/greet.ts'], criteria: ['C1'] });
    const { ctx } = contextFor(projectDir, sessionId, task);
    const attempt = await getChangedFilesSnapshot(projectDir);

    const result = await applyConsultAnswer(
      ctx,
      task,
      {
        answer: {
          diagnosis: 'Only the user knows',
          action: 'ask-user',
          question: 'Which store?',
          whyOnlyUserCanAnswer: 'It changes the deployment',
          choices: ['redis', 'memory'],
          default: 'memory',
        },
      },
      attempt,
    );

    expect(result).toEqual({
      action: 'guidance',
      instructions: 'memory',
      context: null,
    });
  });

  it("an ask-user consult with an empty reply publishes one user_message whose qa answer is the question's default", async () => {
    const { projectDir, sessionId } = setupRepo(dirs);
    const task = makeTask({ id: 'T003', suggestedFiles: ['src/greet.ts'], criteria: ['C1'] });
    const { ctx, events } = contextFor(projectDir, sessionId, task, undefined, {
      onPlannerReply: async () => plainUserMessage(''),
    });
    ctx.bus.subscribe(createJsonlSink({ projectDir, sessionId }));
    const attempt = await getChangedFilesSnapshot(projectDir);

    const result = await applyConsultAnswer(
      ctx,
      task,
      {
        answer: {
          diagnosis: 'Only the user knows',
          action: 'ask-user',
          question: 'Which store?',
          whyOnlyUserCanAnswer: 'It changes the deployment',
          choices: ['redis', 'memory'],
          default: 'memory',
        },
      },
      attempt,
    );

    expect(result).toEqual({
      action: 'guidance',
      instructions: 'memory',
      context: null,
    });
    const userMessages = events.filter((event) => event.type === 'user_message');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]).toMatchObject({
      type: 'user_message',
      phase: 'escalating',
      text: 'memory',
      qa: [{ question: 'Which store?', answer: 'memory' }],
    });
    const log = readFileSync(join(sessionDir(projectDir, sessionId), SESSION_LOG_FILE), 'utf-8');
    const entries = log
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      kind: 'message',
      role: 'user',
      phase: 'escalating',
      text: 'memory',
    });
    expect(entries[1]).toMatchObject({
      type: 'user_message',
      phase: 'escalating',
      data: { text: 'memory', qa: [{ question: 'Which store?', answer: 'memory' }] },
    });
  });

  it.each(['memory', 'redis'])(
    'preserves the complete %s message from the production structured reply',
    async (answer) => {
      const { projectDir, sessionId } = setupRepo(dirs);
      const task = makeTask({ id: 'T003', suggestedFiles: ['src/greet.ts'], criteria: ['C1'] });
      const { ctx, events } = contextFor(projectDir, sessionId, task, undefined, {
        onPlannerReply: async () => ({
          message: plainUserMessage(`1. Which store?\n${answer}`),
          qa: [{ question: 'Which store?', answer }],
        }),
      });
      const result = await applyConsultAnswer(
        ctx,
        task,
        {
          answer: {
            diagnosis: 'Only the user knows',
            action: 'ask-user',
            question: 'Which store?',
            whyOnlyUserCanAnswer: 'It changes the deployment',
            choices: ['redis', 'memory'],
            default: 'memory',
          },
        },
        EMPTY_SNAPSHOT,
      );
      expect(result).toEqual({
        action: 'guidance',
        instructions: `1. Which store?\n${answer}`,
        context: null,
      });
      expect(events.filter((event) => event.type === 'user_message')).toEqual([
        expect.objectContaining({
          text: `1. Which store?\n${answer}`,
          qa: [{ question: 'Which store?', answer }],
        }),
      ]);
    },
  );

  it('an ask-user consult with a typed reply publishes one user_message with that text', async () => {
    const { projectDir, sessionId } = setupRepo(dirs);
    const task = makeTask({ id: 'T003', suggestedFiles: ['src/greet.ts'], criteria: ['C1'] });
    const { ctx, events } = contextFor(projectDir, sessionId, task, undefined, {
      onPlannerReply: async () => plainUserMessage('redis'),
    });
    const attempt = await getChangedFilesSnapshot(projectDir);

    const result = await applyConsultAnswer(
      ctx,
      task,
      {
        answer: {
          diagnosis: 'Only the user knows',
          action: 'ask-user',
          question: 'Which store?',
          whyOnlyUserCanAnswer: 'It changes the deployment',
          choices: ['redis', 'memory'],
          default: 'memory',
        },
      },
      attempt,
    );

    expect(result).toEqual({
      action: 'guidance',
      instructions: 'redis',
      context: null,
    });
    const userMessages = events.filter((event) => event.type === 'user_message');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]).toMatchObject({
      type: 'user_message',
      phase: 'escalating',
      text: 'redis',
      qa: [{ question: 'Which store?', answer: 'redis' }],
    });
  });

  it('asks the operator when a rewrite changes criteria and fails without an answer', async () => {
    const { projectDir, sessionId } = setupRepo(dirs);
    const task = makeTask({
      id: 'T003',
      suggestedFiles: ['src/greet.ts'],
      criteria: ['C1', 'C2'],
      status: 'failed',
    });
    const onPlannerReply = vi.fn().mockResolvedValue(undefined);
    const { ctx, states } = contextFor(projectDir, sessionId, task, undefined, {
      onPlannerReply,
    });
    const attempt = await getChangedFilesSnapshot(projectDir);
    writeFileSync(join(projectDir, 'src/greet.ts'), ATTEMPT_GREET);

    const result = await applyConsultAnswer(
      ctx,
      task,
      rewrite(makeTaskSpec({ id: 'T003', criteria: ['C2'], suggestedFiles: ['src/greet.ts'] })),
      attempt,
    );

    expect(onPlannerReply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        seat: 'plan',
        text: expect.stringContaining('SPLITBRIEF asked the planner to fix T003'),
        questions: [expect.objectContaining({ text: expect.stringContaining('C1') })],
        answered: false,
      }),
    );
    expect(result).toEqual({
      action: 'failed',
      reason: "The planner's question remains unanswered.",
    });
    // The guard runs before the rollback: the attempt's write is still on disk.
    expect(readFileSync(join(projectDir, 'src/greet.ts'), 'utf-8')).toBe(ATTEMPT_GREET);
    expect(states).toHaveLength(0);
  });

  it('asks the operator on the review seat when a fix-task rewrite changes criteria', async () => {
    const { projectDir, sessionId } = setupRepo(dirs);
    const task = makeTask({
      id: 'T003',
      suggestedFiles: ['src/greet.ts'],
      criteria: ['C1', 'C2'],
      status: 'failed',
      fix: { cycle: 1, findings: [{ id: 'F1', text: 'Fix the greeting', acceptance: null }] },
    });
    const onPlannerReply = vi.fn().mockResolvedValue(undefined);
    const { ctx, states } = contextFor(projectDir, sessionId, task, undefined, {
      onPlannerReply,
    });
    const attempt = await getChangedFilesSnapshot(projectDir);

    const result = await applyConsultAnswer(
      { ...ctx, seat: 'review' },
      task,
      rewrite(makeTaskSpec({ id: 'T003', criteria: ['C2'], suggestedFiles: ['src/greet.ts'] })),
      attempt,
    );

    expect(onPlannerReply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        seat: 'review',
        text: expect.stringContaining('SPLITBRIEF asked the reviewer to fix T003'),
        questions: [expect.objectContaining({ text: expect.stringContaining('C1') })],
        answered: false,
      }),
    );
    expect(result).toEqual({
      action: 'failed',
      reason: "The reviewer's question remains unanswered.",
    });
    expect(states).toHaveLength(0);
  });

  it('asks the operator when a split drops a criterion and fails without an answer', async () => {
    const { projectDir, sessionId } = setupRepo(dirs);
    const task = makeTask({
      id: 'T003',
      suggestedFiles: ['src/greet.ts'],
      criteria: ['C1', 'C2'],
      status: 'failed',
    });
    const onPlannerReply = vi.fn().mockResolvedValue(undefined);
    const { ctx, states } = contextFor(projectDir, sessionId, task, undefined, {
      onPlannerReply,
    });
    const attempt = await getChangedFilesSnapshot(projectDir);

    const result = await applyConsultAnswer(
      ctx,
      task,
      split([
        makeTaskSpec({ id: 'T003', criteria: ['C1'], suggestedFiles: ['src/a.ts'] }),
        makeTaskSpec({ id: 'T004', criteria: ['C3'], suggestedFiles: ['src/b.ts'] }),
      ]),
      attempt,
    );

    expect(onPlannerReply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        seat: 'plan',
        questions: [expect.objectContaining({ text: expect.stringContaining('C2') })],
      }),
    );
    expect(result).toEqual({
      action: 'failed',
      reason: "The planner's question remains unanswered.",
    });
    expect(states).toHaveLength(0);
  });

  it('a rewrite that repairs a check command under the same id is applied', async () => {
    const { projectDir, sessionId } = setupRepo(dirs);
    const task = makeTask({
      id: 'T003',
      suggestedFiles: ['src/greet.ts'],
      criteria: ['C1'],
      checks: [{ id: 'K1', kind: 'test', value: 'src/greet.test.ts', required: true }],
      status: 'failed',
    });
    const plan: Plan = {
      summary: 'Fix the greeting',
      decisions: [],
      criteria: [{ id: 'C1', text: 'A greeting is returned', checkIds: ['K1'] }],
      checks: [{ id: 'K1', kind: 'test', value: 'src/greet.test.ts', required: true }],
      validation: null,
    };
    const { ctx, states } = contextFor(projectDir, sessionId, task, plan);
    const attempt = await getChangedFilesSnapshot(projectDir);

    const result = await applyConsultAnswer(
      ctx,
      task,
      rewrite(
        makeTaskSpec({
          id: 'T003',
          criteria: ['C1'],
          checks: [{ id: 'K1', kind: 'cmd', value: 'npm run greet-test', required: true }],
          suggestedFiles: ['src/greet.ts'],
        }),
      ),
      attempt,
    );

    if (result.action !== 'rewrite-task') throw new Error(`expected rewrite, got ${result.action}`);
    expect(result.task.checks).toEqual([
      { id: 'K1', kind: 'cmd', value: 'npm run greet-test', required: true },
    ]);
    expect(states).toHaveLength(1);
  });

  it('asks the operator when a rewrite drops a required check and fails without an answer', async () => {
    const { projectDir, sessionId } = setupRepo(dirs);
    const task = makeTask({
      id: 'T003',
      suggestedFiles: ['src/greet.ts'],
      criteria: ['C1'],
      checks: [{ id: 'K1', kind: 'test', value: 'src/greet.test.ts', required: true }],
      status: 'failed',
    });
    const plan: Plan = {
      summary: 'Fix the greeting',
      decisions: [],
      criteria: [{ id: 'C1', text: 'A greeting is returned', checkIds: ['K1'] }],
      checks: [{ id: 'K1', kind: 'test', value: 'src/greet.test.ts', required: true }],
      validation: null,
    };
    const onPlannerReply = vi.fn().mockResolvedValue(undefined);
    const { ctx, states } = contextFor(projectDir, sessionId, task, plan, { onPlannerReply });
    const attempt = await getChangedFilesSnapshot(projectDir);
    writeFileSync(join(projectDir, 'src/greet.ts'), ATTEMPT_GREET);

    const result = await applyConsultAnswer(
      ctx,
      task,
      rewrite(
        makeTaskSpec({
          id: 'T003',
          criteria: ['C1'],
          checks: [],
          suggestedFiles: ['src/greet.ts'],
        }),
      ),
      attempt,
    );

    expect(onPlannerReply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        seat: 'plan',
        questions: [expect.objectContaining({ text: expect.stringContaining('K1') })],
      }),
    );
    expect(result).toEqual({
      action: 'failed',
      reason: "The planner's question remains unanswered.",
    });
    // The guard runs before the rollback: the attempt's write is still on disk.
    expect(readFileSync(join(projectDir, 'src/greet.ts'), 'utf-8')).toBe(ATTEMPT_GREET);
    expect(states).toHaveLength(0);
  });

  it('rewrite-task rolls the attempt back, replaces the task and publishes task_replaced', async () => {
    const { projectDir, sessionId } = setupRepo(dirs);
    const task = makeTask({
      id: 'T003',
      suggestedFiles: ['src/greet.ts'],
      criteria: ['C1'],
      status: 'failed',
    });
    const { ctx, states, events } = contextFor(projectDir, sessionId, task);
    const attempt = {
      ...(await getChangedFilesSnapshot(projectDir)),
      restoreFiles: ['src/greet.ts'],
    };
    writeFileSync(join(projectDir, 'src/greet.ts'), ATTEMPT_GREET);

    const result = await applyConsultAnswer(
      ctx,
      task,
      rewrite(
        makeTaskSpec({
          id: 'T003',
          criteria: ['C1'],
          suggestedFiles: ['src/greet.ts'],
          contextFiles: ['src/context.ts'],
        }),
      ),
      attempt,
    );

    expect(readFileSync(join(projectDir, 'src/greet.ts'), 'utf-8')).toBe(BASE_GREET);
    if (result.action !== 'rewrite-task') throw new Error(`expected rewrite, got ${result.action}`);
    expect(result.task.revision).toBe(2);
    expect(result.task.status).toBe('pending');
    expect(result.task.criteria).toEqual(['C1']);
    expect(states).toHaveLength(1);
    expect(states[0]?.tasks[0]?.revision).toBe(2);
    expect(events.filter((event) => event.type === 'task_replaced')).toMatchObject([
      { taskId: 'T003', revision: 2 },
    ]);
    expect(events.filter((event) => event.type === 'tasks_planned')).toMatchObject([
      {
        total: 1,
        tasks: [{ id: 'T003', title: result.task.title, file: 'src/greet.ts', index: 0 }],
      },
    ]);
    expect(events.findIndex((event) => event.type === 'tasks_planned')).toBeLessThan(
      events.findIndex((event) => event.type === 'task_replaced'),
    );
  });

  it('split-task rolls the attempt back, inserts the subtasks and publishes tasks_inserted', async () => {
    const { projectDir, sessionId } = setupRepo(dirs);
    const task = makeTask({
      id: 'T003',
      suggestedFiles: ['src/greet.ts'],
      criteria: ['C1', 'C2'],
      status: 'failed',
    });
    const { ctx, states, events } = contextFor(projectDir, sessionId, task);
    const attempt = {
      ...(await getChangedFilesSnapshot(projectDir)),
      restoreFiles: ['src/greet.ts'],
    };
    writeFileSync(join(projectDir, 'src/greet.ts'), ATTEMPT_GREET);

    const result = await applyConsultAnswer(
      ctx,
      task,
      split([
        makeTaskSpec({ id: 'T003', criteria: ['C1'], suggestedFiles: ['src/split-a.ts'] }),
        makeTaskSpec({
          id: 'T004',
          criteria: ['C2'],
          suggestedFiles: ['src/split-b.ts'],
          dependsOn: ['T003'],
        }),
      ]),
      attempt,
    );

    expect(readFileSync(join(projectDir, 'src/greet.ts'), 'utf-8')).toBe(BASE_GREET);
    if (result.action !== 'split-task') throw new Error(`expected split, got ${result.action}`);
    expect(result.tasks.map((child) => child.id)).toEqual(['T004', 'T005']);
    expect(result.tasks.map((child) => child.parentId)).toEqual(['T003', 'T003']);
    expect(result.tasks[1]?.dependsOn).toEqual(['T004']);
    expect(result.tasks[0]?.criteria).toEqual(['C1']);
    expect(result.tasks[1]?.criteria).toEqual(['C2']);
    expect(states).toHaveLength(1);
    expect(states[0]?.tasks.map((childTask) => childTask.id)).toEqual(['T004', 'T005']);
    expect(events.filter((event) => event.type === 'tasks_inserted')).toMatchObject([
      { parentId: 'T003', taskIds: ['T004', 'T005'] },
    ]);
    expect(events.filter((event) => event.type === 'tasks_planned')).toMatchObject([
      {
        total: 2,
        tasks: [
          { id: 'T004', index: 0, file: 'src/split-a.ts' },
          { id: 'T005', index: 1, file: 'src/split-b.ts' },
        ],
      },
    ]);
    expect(events.findIndex((event) => event.type === 'tasks_planned')).toBeLessThan(
      events.findIndex((event) => event.type === 'tasks_inserted'),
    );
    expect(
      events.find((event) => event.type === 'tasks_planned')?.tasks.map((task) => task.id),
    ).toEqual(states[0]?.tasks.map((task) => task.id));
  });

  it('split-task fails when the saved run has no parent to split', async () => {
    const { projectDir, sessionId } = setupRepo(dirs);
    const task = makeTask({
      id: 'T003',
      suggestedFiles: ['src/greet.ts'],
      criteria: ['C1'],
      status: 'failed',
    });
    const { ctx, states, events } = contextFor(projectDir, sessionId, task);
    const missing = makeTask({
      id: 'T007',
      suggestedFiles: ['src/greet.ts'],
      criteria: ['C1'],
      status: 'failed',
    });
    const attempt = await getChangedFilesSnapshot(projectDir);

    await expect(
      applyConsultAnswer(
        ctx,
        missing,
        split([makeTaskSpec({ id: 'T007', criteria: ['C1'], suggestedFiles: ['src/a.ts'] })]),
        attempt,
      ),
    ).rejects.toMatchObject({ kind: 'consult-apply-task-missing' });
    expect(states.at(-1)?.tasks.map((saved) => saved.id)).toEqual(['T003']);
    expect(events.filter((event) => event.type === 'tasks_inserted')).toHaveLength(0);
  });
});

describe('a consult on a brief that created its files', () => {
  const FRESH = 'export const fresh = 1;\n';

  function createTask(suggestedFiles: Task['suggestedFiles'] = ['src/fresh.ts']): Task {
    return makeTask({
      id: 'T003',
      action: 'create',
      suggestedFiles,
      criteria: ['C1', 'C2'],
      status: 'failed',
    });
  }

  /**
   * The lineage start is recorded at the brief's first dispatch; attempt 1 then writes `files`.
   * The current attempt starts on them, so its restore keeps them.
   */
  async function startedLineage(
    projectDir: string,
    sessionId: string,
    task: Task,
    files: Record<string, string>,
  ): Promise<{
    ctx: ConsultApplyContext;
    states: WorkflowState[];
    attempt: ChangedFilesSnapshot;
  }> {
    const { ctx, states } = contextFor(projectDir, sessionId, task);
    const start = await getChangedFilesSnapshot(projectDir);
    const state = transition(
      {
        ...ctx.state,
        changedFilesBaseline: { head: null, fingerprints: {}, activeTaskSnapshot: start },
      },
      { type: 'RECORD_DISPATCH', taskId: task.id },
    );
    saveState({ projectDir, sessionId }, state);
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(projectDir, file)), { recursive: true });
      writeFileSync(join(projectDir, file), content);
    }
    return { ctx: { ...ctx, state }, states, attempt: await getChangedFilesSnapshot(projectDir) };
  }

  async function dispatch(projectDir: string, sessionId: string, task: Task): Promise<Task> {
    const state = loadState({ projectDir, sessionId });
    if (state === null) throw new Error('no saved state');
    return (
      await refreshAndPersistCode(task, { projectDir, sessionId }, state, projectDir, 'dispatch')
    ).task;
  }

  it('a rewrite that keeps the anchor keeps create, also at its dispatch', async () => {
    const { projectDir, sessionId } = setupRepo(dirs);
    const task = createTask();
    const { ctx, attempt } = await startedLineage(projectDir, sessionId, task, {
      'src/fresh.ts': FRESH,
    });

    const result = await applyConsultAnswer(
      ctx,
      task,
      rewrite(
        makeTaskSpec({ id: 'T003', criteria: ['C1', 'C2'], suggestedFiles: ['src/fresh.ts'] }),
      ),
      attempt,
    );

    if (result.action !== 'rewrite-task') throw new Error(`expected rewrite, got ${result.action}`);
    expect(result.task.action).toBe('create');
    const dispatched = await dispatch(projectDir, sessionId, result.task);
    expect(dispatched.action).toBe('create');
    expect(dispatched.currentCode).toBe(FRESH);
  });

  it('a split into an implementation child and a test child keeps create for both files the parent created', async () => {
    const { projectDir, sessionId } = setupRepo(dirs);
    const task = createTask(['src/fresh.ts', 'src/fresh.test.ts']);
    const { ctx, attempt } = await startedLineage(projectDir, sessionId, task, {
      'src/fresh.ts': FRESH,
      'src/fresh.test.ts': 'import "./fresh";\n',
    });

    const result = await applyConsultAnswer(
      ctx,
      task,
      split([
        makeTaskSpec({ id: 'T003', criteria: ['C1'], suggestedFiles: ['src/fresh.ts'] }),
        makeTaskSpec({
          id: 'T004',
          criteria: ['C2'],
          suggestedFiles: ['src/fresh.test.ts'],
          dependsOn: ['T003'],
        }),
      ]),
      attempt,
    );

    if (result.action !== 'split-task') throw new Error(`expected split, got ${result.action}`);
    expect(result.tasks.map((child) => child.action)).toEqual(['create', 'create']);
    const testChild = result.tasks[1];
    if (testChild === undefined) throw new Error('the split saved no test child');
    expect((await dispatch(projectDir, sessionId, testChild)).action).toBe('create');
  });

  it('a rewrite onto a later file the brief created keeps create', async () => {
    const { projectDir, sessionId } = setupRepo(dirs);
    const task = createTask(['src/fresh.ts', 'src/fresh.test.ts']);
    const { ctx, attempt } = await startedLineage(projectDir, sessionId, task, {
      'src/fresh.ts': FRESH,
      'src/fresh.test.ts': 'import "./fresh";\n',
    });

    const result = await applyConsultAnswer(
      ctx,
      task,
      rewrite(
        makeTaskSpec({ id: 'T003', criteria: ['C1', 'C2'], suggestedFiles: ['src/fresh.test.ts'] }),
      ),
      attempt,
    );

    if (result.action !== 'rewrite-task') throw new Error(`expected rewrite, got ${result.action}`);
    expect(result.task.action).toBe('create');
  });

  it('an empty file the brief created keeps create after a rewrite and at its dispatch', async () => {
    const { projectDir, sessionId } = setupRepo(dirs);
    const task = createTask(['pkg/__init__.py']);
    const { ctx, attempt } = await startedLineage(projectDir, sessionId, task, {
      'pkg/__init__.py': '',
    });

    const result = await applyConsultAnswer(
      ctx,
      task,
      rewrite(
        makeTaskSpec({ id: 'T003', criteria: ['C1', 'C2'], suggestedFiles: ['pkg/__init__.py'] }),
      ),
      attempt,
    );

    if (result.action !== 'rewrite-task') throw new Error(`expected rewrite, got ${result.action}`);
    expect(result.task.action).toBe('create');
    expect((await dispatch(projectDir, sessionId, result.task)).action).toBe('create');
  });

  it('a split child keeps create for the anchor its sibling created after the split', async () => {
    const { projectDir, sessionId } = setupRepo(dirs);
    const task = createTask();
    const { ctx, attempt } = await startedLineage(projectDir, sessionId, task, {
      'src/fresh.ts': FRESH,
    });

    const result = await applyConsultAnswer(
      ctx,
      task,
      split([
        makeTaskSpec({ id: 'T003', criteria: ['C1'], suggestedFiles: ['src/fresh.ts'] }),
        makeTaskSpec({
          id: 'T004',
          criteria: ['C2'],
          suggestedFiles: ['src/later.ts'],
          dependsOn: ['T003'],
        }),
      ]),
      attempt,
    );

    if (result.action !== 'split-task') throw new Error(`expected split, got ${result.action}`);
    const [first, second] = result.tasks;
    if (first === undefined || second === undefined) throw new Error('the split saved no children');
    expect((await dispatch(projectDir, sessionId, first)).action).toBe('create');
    writeFileSync(join(projectDir, 'src/later.ts'), 'export const later = 1;\n');
    expect((await dispatch(projectDir, sessionId, second)).action).toBe('create');
  });

  it.each(['rewrite', 'split'] as const)(
    'a %s onto a file the checkout held before the task reads modify',
    async (kind) => {
      const { projectDir, sessionId } = setupRepo(dirs);
      const task = createTask();
      const { ctx, attempt } = await startedLineage(projectDir, sessionId, task, {
        'src/fresh.ts': FRESH,
      });
      const answer =
        kind === 'rewrite'
          ? rewrite(
              makeTaskSpec({
                id: 'T003',
                criteria: ['C1', 'C2'],
                suggestedFiles: ['src/greet.ts'],
              }),
            )
          : split([
              makeTaskSpec({ id: 'T003', criteria: ['C1'], suggestedFiles: ['src/greet.ts'] }),
              makeTaskSpec({ id: 'T004', criteria: ['C2'], suggestedFiles: ['src/context.ts'] }),
            ]);

      const result = await applyConsultAnswer(ctx, task, answer, attempt);

      const actions =
        result.action === 'rewrite-task'
          ? [result.task.action]
          : result.action === 'split-task'
            ? result.tasks.map((child) => child.action)
            : [];
      expect(actions).toEqual(kind === 'rewrite' ? ['modify'] : ['modify', 'modify']);
    },
  );

  it.each([
    ['an uncommitted file of the user', 'src/notes.ts', ''],
    ['a git-ignored file of the user', 'local/settings.ts', 'local/\n'],
  ])(
    'a rewrite onto %s that was there when the lineage started reads modify',
    async (_label, file, ignore) => {
      const { projectDir, sessionId } = setupRepo(dirs);
      writeFileSync(join(projectDir, '.gitignore'), ignore);
      mkdirSync(dirname(join(projectDir, file)), { recursive: true });
      writeFileSync(join(projectDir, file), 'export const mine = 1;\n');
      const task = createTask();
      const { ctx, attempt } = await startedLineage(projectDir, sessionId, task, {
        'src/fresh.ts': FRESH,
      });

      const result = await applyConsultAnswer(
        ctx,
        task,
        rewrite(makeTaskSpec({ id: 'T003', criteria: ['C1', 'C2'], suggestedFiles: [file] })),
        attempt,
      );

      if (result.action !== 'rewrite-task')
        throw new Error(`expected rewrite, got ${result.action}`);
      expect(result.task.action).toBe('modify');
    },
  );

  it('a lineage with no recorded start reads the workspace', async () => {
    const { projectDir, sessionId } = setupRepo(dirs);
    const task = createTask();
    writeFileSync(join(projectDir, 'src/fresh.ts'), FRESH);
    const attempt = await getChangedFilesSnapshot(projectDir);
    const { ctx } = contextFor(projectDir, sessionId, task);

    const result = await applyConsultAnswer(
      ctx,
      task,
      rewrite(
        makeTaskSpec({ id: 'T003', criteria: ['C1', 'C2'], suggestedFiles: ['src/fresh.ts'] }),
      ),
      attempt,
    );

    if (result.action !== 'rewrite-task') throw new Error(`expected rewrite, got ${result.action}`);
    expect(result.task.action).toBe('modify');
  });
});
