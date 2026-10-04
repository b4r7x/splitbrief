import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConsultAnswer } from '../../../core/schemas/consult.js';
import type { TaskSpec } from '../../../core/schemas/plan.js';
import { taskId, type Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { saveState } from '../../../core/state/persistence.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
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
): { ctx: ConsultApplyContext; states: WorkflowState[]; events: EngineEvent[] } {
  const state: WorkflowState = {
    ...transition(createInitialState('Fix the greeting'), { type: 'START' }),
    phase: 'escalating',
    tasks: [task],
    currentTaskIndex: 0,
    attempt: 1,
  };
  saveState({ projectDir, sessionId }, state);
  const { bus, events } = makeBusRecorder();
  const states: WorkflowState[] = [];
  return {
    ctx: {
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      bus,
      config: makeConfig({}),
      validator: createValidator(),
      callbacks: makeCallbacks().callbacks,
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
      file: 'src/greet.ts',
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
    const task = makeTask({ id: 'T003', file: 'src/greet.ts', criteria: ['C1'] });
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

  it('a rewrite whose criteria differ becomes ask-user naming the dropped criterion', async () => {
    const { projectDir, sessionId } = setupRepo(dirs);
    const task = makeTask({
      id: 'T003',
      file: 'src/greet.ts',
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
      file: 'src/greet.ts',
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

  it('a split of a subtask becomes ask-user', async () => {
    const { projectDir, sessionId } = setupRepo(dirs);
    const task = makeTask({
      id: 'T005',
      parentId: taskId('T002'),
      file: 'src/greet.ts',
      criteria: ['C1'],
      status: 'failed',
    });
    const { ctx, states } = contextFor(projectDir, sessionId, task);
    const attempt = await getChangedFilesSnapshot(projectDir);

    const result = await applyConsultAnswer(
      ctx,
      task,
      split([
        makeTaskSpec({ id: 'T005', criteria: ['C1'], suggestedFiles: ['src/a.ts'] }),
        makeTaskSpec({ id: 'T006', criteria: ['C1'], suggestedFiles: ['src/b.ts'] }),
      ]),
      attempt,
    );

    expect(questionOf(result)).toContain('subtask');
    expect(states).toHaveLength(0);
  });

  it('a rewrite that changes the id becomes ask-user', async () => {
    const { projectDir, sessionId } = setupRepo(dirs);
    const task = makeTask({
      id: 'T003',
      file: 'src/greet.ts',
      criteria: ['C1'],
      status: 'failed',
    });
    const { ctx, states } = contextFor(projectDir, sessionId, task);
    const attempt = await getChangedFilesSnapshot(projectDir);

    const result = await applyConsultAnswer(
      ctx,
      task,
      rewrite(makeTaskSpec({ id: 'T009', criteria: ['C1'], suggestedFiles: ['src/greet.ts'] })),
      attempt,
    );

    const guarded = questionOf(result);
    expect(guarded).toContain('T009');
    expect(states).toHaveLength(0);
  });

  it('rewrite-task rolls the attempt back, replaces the task with fresh input hashes and publishes task_replaced', async () => {
    const { projectDir, sessionId } = setupRepo(dirs);
    const task = makeTask({
      id: 'T003',
      file: 'src/greet.ts',
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
    const task = makeTask({ id: 'T003', file: 'src/greet.ts', criteria: ['C1'] });
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
      file: 'src/greet.ts',
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
});
