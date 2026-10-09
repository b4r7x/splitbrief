import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConsultAnswer } from '../../../core/schemas/consult.js';
import type { Plan, TaskSpec } from '../../../core/schemas/plan.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { saveState } from '../../../core/state/persistence.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { sessionDir, SESSION_LOG_FILE } from '../../../core/paths.js';
import { createJsonlSink } from '../../events/sinks/jsonl.js';
import { sha256Hex } from '../../../utils/sha256.js';
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
import type { OrchestratorCallbacks } from '../types.js';
import { applyConsultAnswer, type ConsultApplyContext } from './apply.js';

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
      taskStartTime: Date.now(),
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      bus,
      config: makeConfig({}),
      validator: createValidator(),
      callbacks: makeCallbacks(callbacks).callbacks,
      sinks: TEST_SINKS,
      state,
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

function questionOf(result: Awaited<ReturnType<typeof applyConsultAnswer>>): string {
  if (result.action !== 'ask-user') throw new Error(`expected ask-user, got ${result.action}`);
  return result.question;
}

describe('applyConsultAnswer', () => {
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
      onPlannerReply: async () => '',
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
    expect(log.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(log)).toMatchObject({
      type: 'user_message',
      phase: 'escalating',
      data: { text: 'memory', qa: [{ question: 'Which store?', answer: 'memory' }] },
    });
  });

  it.each(['memory', 'redis'])(
    'records only the %s answer from the production structured reply',
    async (answer) => {
      const { projectDir, sessionId } = setupRepo(dirs);
      const task = makeTask({ id: 'T003', suggestedFiles: ['src/greet.ts'], criteria: ['C1'] });
      const { ctx, events } = contextFor(projectDir, sessionId, task, undefined, {
        onPlannerReply: async () => ({
          text: `1. Which store?\n${answer}`,
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
        null,
      );
      expect(result).toEqual({ action: 'guidance', instructions: answer, context: null });
      expect(events.filter((event) => event.type === 'user_message')).toEqual([
        expect.objectContaining({ text: answer, qa: [{ question: 'Which store?', answer }] }),
      ]);
    },
  );

  it('an ask-user consult with a typed reply publishes one user_message with that text', async () => {
    const { projectDir, sessionId } = setupRepo(dirs);
    const task = makeTask({ id: 'T003', suggestedFiles: ['src/greet.ts'], criteria: ['C1'] });
    const { ctx, events } = contextFor(projectDir, sessionId, task, undefined, {
      onPlannerReply: async () => 'redis',
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

  it('a rewrite whose criteria differ becomes ask-user naming the dropped criterion', async () => {
    const { projectDir, sessionId } = setupRepo(dirs);
    const task = makeTask({
      id: 'T003',
      suggestedFiles: ['src/greet.ts'],
      criteria: ['C1', 'C2'],
      status: 'failed',
    });
    const { ctx, states } = contextFor(projectDir, sessionId, task);
    const attempt = await getChangedFilesSnapshot(projectDir);
    writeFileSync(join(projectDir, 'src/greet.ts'), ATTEMPT_GREET);

    const result = await applyConsultAnswer(
      ctx,
      task,
      rewrite(makeTaskSpec({ id: 'T003', criteria: ['C2'], suggestedFiles: ['src/greet.ts'] })),
      attempt,
    );

    expect(questionOf(result)).toContain('C1');
    // The guard runs before the rollback: the attempt's write is still on disk.
    expect(readFileSync(join(projectDir, 'src/greet.ts'), 'utf-8')).toBe(ATTEMPT_GREET);
    expect(states).toHaveLength(0);
  });

  it('a split that together misses a criterion becomes ask-user naming it', async () => {
    const { projectDir, sessionId } = setupRepo(dirs);
    const task = makeTask({
      id: 'T003',
      suggestedFiles: ['src/greet.ts'],
      criteria: ['C1', 'C2'],
      status: 'failed',
    });
    const { ctx, states } = contextFor(projectDir, sessionId, task);
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

    expect(questionOf(result)).toContain('C2');
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

  it('a rewrite that drops a check its criteria require becomes ask-user', async () => {
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

    expect(questionOf(result)).toContain('K1');
    // The guard runs before the rollback: the attempt's write is still on disk.
    expect(readFileSync(join(projectDir, 'src/greet.ts'), 'utf-8')).toBe(ATTEMPT_GREET);
    expect(states).toHaveLength(0);
  });

  it('rewrite-task rolls the attempt back, replaces the task with fresh input hashes and publishes task_replaced', async () => {
    const { projectDir, sessionId } = setupRepo(dirs);
    const task = makeTask({
      id: 'T003',
      suggestedFiles: ['src/greet.ts'],
      criteria: ['C1'],
      status: 'failed',
    });
    const { ctx, states, events } = contextFor(projectDir, sessionId, task);
    const attempt = await getChangedFilesSnapshot(projectDir);
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
    expect(result.task.inputHashes).toEqual({
      'src/greet.ts': sha256Hex(BASE_GREET),
      'src/context.ts': sha256Hex(CONTEXT),
    });
    expect(states).toHaveLength(1);
    expect(states[0]?.tasks[0]?.revision).toBe(2);
    expect(events.filter((event) => event.type === 'task_replaced')).toMatchObject([
      { taskId: 'T003', revision: 2 },
    ]);
  });

  it('a rewritten task records workspace hashes', async () => {
    const { projectDir, sessionId } = setupRepo(dirs);
    const workspaceDir = createTempDir('consult-apply-workspace');
    dirs.push(workspaceDir);
    createTestGitRepo(workspaceDir, {
      'src/greet.ts': ATTEMPT_GREET,
      'src/context.ts': 'export const context = false;\n',
    });
    const task = makeTask({ id: 'T003', suggestedFiles: ['src/greet.ts'], criteria: ['C1'] });
    const { ctx } = contextFor(projectDir, sessionId, task);

    const result = await applyConsultAnswer(
      { ...ctx, workspaceDir },
      task,
      rewrite(
        makeTaskSpec({
          id: 'T003',
          criteria: ['C1'],
          suggestedFiles: ['src/greet.ts'],
          contextFiles: ['src/context.ts'],
        }),
      ),
      null,
    );

    if (result.action !== 'rewrite-task') throw new Error(`expected rewrite, got ${result.action}`);
    expect(result.task.inputHashes).toEqual({
      'src/greet.ts': sha256Hex(ATTEMPT_GREET),
      'src/context.ts': sha256Hex('export const context = false;\n'),
    });
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
    const attempt = await getChangedFilesSnapshot(projectDir);
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
