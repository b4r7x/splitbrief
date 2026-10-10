import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  makeBusRecorder,
  makeCallbacks,
  makeImplementer,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplStateWithMetadata as implementingState } from '#testing/helpers/factories/workflow-state.js';
import { consultCallAnswering } from '#testing/helpers/typed-planner.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext as makeWorkflowContext,
  setupTaskProject as setupProject,
} from '#testing/helpers/orchestrator-task-context.js';
import type { ConsultAnswer, ConsultSeat } from '../../../core/schemas/consult.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { EventBus } from '../../events/types.js';
import type { Planner } from '../../planners/types.js';
import type { OrchestratorCallbacks } from '../types.js';
import { loadState } from '../../../core/state/persistence.js';
import { hashTaskBrief } from '../../../core/evidence/brief-hash.js';
import { type ContinuationHolder, createContinuationHolder } from '../continuation.js';
import { applyRecoveryAction } from '../recovery/actions.js';
import { inputHashesNow, specInputFiles } from './stale-inputs.js';
import { runSingleTask } from './step.js';

const workspaceDirs: string[] = [];
afterEach(() => {
  cleanupTaskProjects();
  for (const dir of workspaceDirs.splice(0)) cleanupTempDir(dir);
});

const SHARED = 'export const shared = 1;\n';
const EDITED_SHARED = 'export const shared = 2;\n';
const OTHER = 'export const other = 1;\n';
const EDITED_OTHER = 'export const other = 2;\n';

function guidanceAnswer(instructions: string): ConsultAnswer {
  return {
    answer: {
      diagnosis: 'The inputs moved under the brief.',
      action: 'guidance',
      instructions,
      context: null,
    },
  };
}

function staleRewriteAnswer(criteria: string[] = ['C1']): ConsultAnswer {
  return {
    answer: {
      diagnosis: 'The brief should read the new context.',
      action: 'rewrite-task',
      task: makeTaskSpec({
        id: 'T002',
        criteria,
        suggestedFiles: ['src/b.ts'],
        contextFiles: ['src/shared.ts'],
      }),
    },
  };
}

function staleTask(projectDir: string, id = 'T002'): Task {
  const task = makeTask({
    id,
    action: 'create',
    suggestedFiles: ['src/b.ts'],
    contextFiles: ['src/shared.ts'],
    criteria: ['C1'],
  });
  const contextFiles = task.contextFiles ?? [];
  return {
    ...task,
    inputHashes: inputHashesNow(
      projectDir,
      specInputFiles({ suggestedFiles: task.suggestedFiles, contextFiles }),
    ),
  };
}

function setupGuardQuestion(seat: ConsultSeat) {
  const ref = setupProject({ 'src/shared.ts': SHARED });
  const task = makeTask({
    ...staleTask(ref.projectDir),
    checks: [{ id: 'K2', kind: 'cmd', value: 'node --version', required: true }],
    ...(seat === 'review' && {
      fix: { cycle: 1, findings: [{ id: 'F1', text: 'Fix the shared import', acceptance: null }] },
    }),
  });
  const state: WorkflowState = {
    ...implementingState([task, trailingTask()]),
    plan: {
      summary: 'Read the shared import',
      decisions: [],
      criteria: [{ id: 'C1', text: 'Read the shared import', checkIds: ['K2'] }],
      checks: task.checks ?? [],
      validation: null,
    },
  };
  return { ...ref, task, state };
}

const guardCases = [
  { seat: 'plan', violation: 'criteria' },
  { seat: 'review', violation: 'criteria' },
  { seat: 'plan', violation: 'required check' },
  { seat: 'review', violation: 'required check' },
] as const;

/** A second pending brief, so a completed T002 is not the loop-boundary state. */
function trailingTask(): Task {
  return makeTask({
    id: 'T003',
    action: 'create',
    suggestedFiles: ['src/c.ts'],
    criteria: ['C1'],
  });
}

/** An implementer that fails its attempt without writing, so the task stays pending. */
function failingImplementer(): ReturnType<typeof makeImplementer> {
  return makeImplementer({
    implement: async () => ({ success: false, output: '', error: 'the attempt failed' }),
  });
}

function runForTask(opts: {
  projectDir: string;
  sessionId: string;
  task: Task;
  state: WorkflowState;
  planner: Planner;
  reviewer?: Planner;
  implementer?: ReturnType<typeof makeImplementer>;
  bus?: EventBus;
  workspaceDir?: string;
  continuation?: ContinuationHolder;
  callbacks?: OrchestratorCallbacks;
}): Promise<WorkflowState> {
  return runSingleTask({
    wctx: makeWorkflowContext({
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      ...(opts.workspaceDir !== undefined && { workspaceDir: opts.workspaceDir }),
      planner: opts.planner,
      ...(opts.reviewer !== undefined && { reviewer: opts.reviewer }),
      implementer: opts.implementer ?? failingImplementer(),
      callbacks: opts.callbacks ?? makeCallbacks().callbacks,
      ...(opts.bus !== undefined && { bus: opts.bus }),
      ...(opts.continuation !== undefined && { continuation: opts.continuation }),
    }),
    task: opts.task,
    index: opts.state.currentTaskIndex,
    totalTasks: opts.state.tasks.length,
    state: opts.state,
    taskBreakdowns: [],
    setTrackedState: () => {},
    setCurrentTask: () => {},
  });
}

function taskIn(state: WorkflowState, id: string): Task {
  const found = state.tasks.find((task) => task.id === id);
  if (found === undefined) throw new Error(`task ${id} left the run`);
  return found;
}

async function retryStaleTask(opts: Parameters<typeof runForTask>[0]): Promise<WorkflowState> {
  const retried = await applyRecoveryAction({
    projectDir: opts.projectDir,
    sessionId: opts.sessionId,
    config: makeConfig(),
    bus: opts.bus ?? makeBusRecorder().bus,
    state: opts.state,
    action: 'retry-same-worker',
  });
  expect(retried.ok).toBe(true);
  if (!retried.ok) throw new Error(retried.message);
  expect(retried.status).toBe('retry-current-task');
  const task = taskIn(retried.state, opts.task.id);
  expect(task.status).toBe('pending');
  expect(task.inputHashes).toEqual(opts.task.inputHashes);
  expect(loadState(opts)?.tasks[0]?.inputHashes).toEqual(opts.task.inputHashes);
  return runForTask({ ...opts, task, state: retried.state });
}

/** The run's state again at the top of the same brief: the halt cleared, the task pending. */
function redispatchState(state: WorkflowState, taskId: string): WorkflowState {
  return {
    ...state,
    pendingRecovery: undefined,
    phase: 'implementing',
    currentTaskIndex: 0,
    tasks: state.tasks.map((task) => (task.id === taskId ? { ...task, status: 'pending' } : task)),
  };
}

function staleConsultsOf(
  state: WorkflowState,
  taskId = 'T002',
): { revision: number; action: string }[] {
  return (
    state.lineages?.[taskId]?.consultRecords
      ?.filter((record) => record.reason === 'stale')
      .map((record) => ({ revision: record.revision, action: record.action })) ?? []
  );
}

describe('runSingleTask — stale refresh', () => {
  it('consults once when a task’s inputs moved and records the fresh hashes', async () => {
    const { projectDir, sessionId } = setupProject({ 'src/shared.ts': SHARED });
    const task = staleTask(projectDir);
    const state = implementingState([task, trailingTask()]);
    const typed = consultCallAnswering(() => guidanceAnswer('Read the new shared file first.'));
    const planner = makePlanner({ typedCall: typed });

    // The earlier task moved T002's context under it before dispatch.
    writeFileSync(join(projectDir, 'src/shared.ts'), EDITED_SHARED);

    const first = await runForTask({ projectDir, sessionId, task, state, planner });

    const staleConsults = staleConsultsOf(first);
    expect(staleConsults).toHaveLength(1);
    expect(first.lineages?.T002?.staleConsultedRevision).toEqual({ T002: 1 });
    expect(taskIn(first, 'T002').inputHashes?.['src/shared.ts']).toBe(
      inputHashesNow(projectDir, ['src/shared.ts'])['src/shared.ts'],
    );

    // The refresh recorded the fresh hashes, so dispatching the same revision again is not stale.
    const before = typed.mock.calls.length;
    await runForTask({
      projectDir,
      sessionId,
      task: taskIn(first, 'T002'),
      state: redispatchState(first, 'T002'),
      planner,
    });
    const after = typed.mock.calls.length;

    expect(after).toBe(before);
  });

  it('asks no stale consult when every moved input is a suggested file of an earlier task', async () => {
    const { projectDir, sessionId } = setupProject({ 'src/shared.ts': SHARED });
    const task = staleTask(projectDir);
    const producer = makeTask({
      id: 'T001',
      action: 'modify',
      suggestedFiles: ['src/shared.ts'],
      criteria: ['C1'],
      status: 'done',
    });
    const state = { ...implementingState([producer, task, trailingTask()]), currentTaskIndex: 1 };
    const typed = consultCallAnswering(() => guidanceAnswer('unused'));
    const planner = makePlanner({ typedCall: typed });

    // T001, which the plan ordered first, wrote the file T002 reads.
    writeFileSync(join(projectDir, 'src/shared.ts'), EDITED_SHARED);

    const after = await runForTask({ projectDir, sessionId, task, state, planner });

    expect(staleConsultsOf(after)).toEqual([]);
    expect(typed).not.toHaveBeenCalled();
  });

  it('consults once for each dependent task whose input moved, not once for the run', async () => {
    const { projectDir, sessionId } = setupProject({ 'src/shared.ts': SHARED });
    const second = staleTask(projectDir);
    const third = staleTask(projectDir, 'T003');
    const producer = makeTask({
      id: 'T001',
      action: 'modify',
      suggestedFiles: ['src/elsewhere.ts'],
      criteria: ['C1'],
      status: 'done',
    });
    const state = { ...implementingState([producer, second, third]), currentTaskIndex: 1 };
    const typed = consultCallAnswering(() => guidanceAnswer('Read the new shared file first.'));
    const planner = makePlanner({ typedCall: typed });

    writeFileSync(join(projectDir, 'src/shared.ts'), EDITED_SHARED);

    const afterSecond = await runForTask({ projectDir, sessionId, task: second, state, planner });
    expect(staleConsultsOf(afterSecond, 'T002')).toHaveLength(1);
    expect(staleConsultsOf(afterSecond, 'T003')).toHaveLength(0);

    const afterThird = await runForTask({
      projectDir,
      sessionId,
      task: taskIn(afterSecond, 'T003'),
      state: redispatchState(afterSecond, 'T003'),
      planner,
    });
    expect(staleConsultsOf(afterThird, 'T002')).toHaveLength(1);
    expect(staleConsultsOf(afterThird, 'T003')).toHaveLength(1);
  });

  it('asks no stale consult of a dependent task when an earlier task was to write the moved input', async () => {
    const { projectDir, sessionId } = setupProject({ 'src/shared.ts': SHARED });
    const second = staleTask(projectDir);
    const third = staleTask(projectDir, 'T003');
    const producer = makeTask({
      id: 'T001',
      action: 'modify',
      suggestedFiles: ['src/shared.ts'],
      criteria: ['C1'],
      status: 'done',
    });
    const state = { ...implementingState([producer, second, third]), currentTaskIndex: 1 };
    const typed = consultCallAnswering(() => guidanceAnswer('unused'));
    const planner = makePlanner({ typedCall: typed });

    writeFileSync(join(projectDir, 'src/shared.ts'), EDITED_SHARED);

    const afterSecond = await runForTask({ projectDir, sessionId, task: second, state, planner });
    expect(staleConsultsOf(afterSecond, 'T002')).toEqual([]);

    const afterThird = await runForTask({
      projectDir,
      sessionId,
      task: taskIn(afterSecond, 'T003'),
      state: redispatchState(afterSecond, 'T003'),
      planner,
    });
    expect(staleConsultsOf(afterThird, 'T002')).toEqual([]);
    expect(staleConsultsOf(afterThird, 'T003')).toEqual([]);
    expect(typed).not.toHaveBeenCalled();
  });

  it('still consults when a moved input is outside what earlier tasks were to write', async () => {
    const { projectDir, sessionId } = setupProject({ 'src/shared.ts': SHARED });
    const task = staleTask(projectDir);
    const producer = makeTask({
      id: 'T001',
      action: 'modify',
      suggestedFiles: ['src/elsewhere.ts'],
      criteria: ['C1'],
      status: 'done',
    });
    const state = { ...implementingState([producer, task, trailingTask()]), currentTaskIndex: 1 };
    const typed = consultCallAnswering(() => guidanceAnswer('Read the new shared file first.'));
    const planner = makePlanner({ typedCall: typed });

    writeFileSync(join(projectDir, 'src/shared.ts'), EDITED_SHARED);

    const after = await runForTask({ projectDir, sessionId, task, state, planner });

    expect(staleConsultsOf(after)).toHaveLength(1);
  });

  it('stale refresh hashes the workspace, not the checkout', async () => {
    const { projectDir, sessionId } = setupProject({ 'src/shared.ts': SHARED });
    const workspaceDir = createTempDir('step-stale-workspace');
    workspaceDirs.push(workspaceDir);
    createTestGitRepo(workspaceDir, { 'src/shared.ts': SHARED });
    const task = staleTask(projectDir);
    const state = implementingState([task, trailingTask()]);
    const typed = consultCallAnswering(() => guidanceAnswer('Read the new shared file first.'));
    const planner = makePlanner({ typedCall: typed });

    writeFileSync(join(projectDir, 'src/shared.ts'), EDITED_SHARED);
    const checkoutEdited = await runForTask({
      projectDir,
      sessionId,
      task,
      state,
      planner,
      workspaceDir,
    });
    expect(staleConsultsOf(checkoutEdited)).toHaveLength(0);

    writeFileSync(join(workspaceDir, 'src/shared.ts'), EDITED_OTHER);
    const workspaceEdited = await runForTask({
      projectDir,
      sessionId,
      task,
      state: redispatchState(checkoutEdited, 'T002'),
      planner,
      workspaceDir,
    });
    expect(staleConsultsOf(workspaceEdited)).toHaveLength(1);
    expect(taskIn(workspaceEdited, 'T002').inputHashes?.['src/shared.ts']).toBe(
      inputHashesNow(workspaceDir, ['src/shared.ts'])['src/shared.ts'],
    );
  });

  it('a resumed cut attempt is not stale against the output it left in the workspace', async () => {
    const { projectDir, sessionId } = setupProject({ 'src/shared.ts': SHARED });
    const task = staleTask(projectDir);
    const state = implementingState([task, trailingTask()]);
    const typed = consultCallAnswering(() => guidanceAnswer('Read the new shared file first.'));
    const planner = makePlanner({ typedCall: typed });
    writeFileSync(join(projectDir, 'src/b.ts'), 'export const partial = true;\n');

    const resumed = await runForTask({
      projectDir,
      sessionId,
      task,
      state,
      planner,
      continuation: createContinuationHolder({
        step: { kind: 'brief', taskId: task.id, attempt: state.attempt },
        keepWorkspace: true,
        briefFingerprint: hashTaskBrief([task]),
      }),
    });

    expect(staleConsultsOf(resumed)).toHaveLength(0);
    expect(typed).not.toHaveBeenCalled();
  });

  it('does not consult the same revision twice after guidance refreshed its hashes', async () => {
    const { projectDir, sessionId } = setupProject({ 'src/shared.ts': SHARED });
    const task = staleTask(projectDir);
    const state = implementingState([task, trailingTask()]);
    const typed = consultCallAnswering(() => guidanceAnswer('Read the new shared file first.'));
    const planner = makePlanner({ typedCall: typed });
    writeFileSync(join(projectDir, 'src/shared.ts'), EDITED_SHARED);

    const first = await runForTask({ projectDir, sessionId, task, state, planner });
    expect(staleConsultsOf(first)).toHaveLength(1);

    // The same revision is moved again; the once-per-revision guard means no second consult.
    writeFileSync(join(projectDir, 'src/shared.ts'), `${EDITED_SHARED}// moved again\n`);
    const before = typed.mock.calls.length;
    await runForTask({
      projectDir,
      sessionId,
      task: taskIn(first, 'T002'),
      state: redispatchState(first, 'T002'),
      planner,
    });

    expect(typed.mock.calls.length).toBe(before);
  });

  it('consults again on the new revision after a rewrite, and only once per revision', async () => {
    const { projectDir, sessionId } = setupProject({ 'src/shared.ts': SHARED });
    const task = staleTask(projectDir);
    const state = implementingState([task, trailingTask()]);
    const typed = consultCallAnswering(() => staleRewriteAnswer());
    const planner = makePlanner({ typedCall: typed });
    const implementer = makeImplementer();
    writeFileSync(join(projectDir, 'src/shared.ts'), EDITED_SHARED);

    const first = await runForTask({ projectDir, sessionId, task, state, planner, implementer });
    expect(taskIn(first, 'T002').revision).toBe(2);
    expect(staleConsultsOf(first)).toEqual([{ revision: 1, action: 'rewrite-task' }]);

    writeFileSync(join(projectDir, 'src/shared.ts'), `${EDITED_SHARED}// moved again\n`);
    const second = await runForTask({
      projectDir,
      sessionId,
      task: taskIn(first, 'T002'),
      state: redispatchState(first, 'T002'),
      planner,
      implementer,
    });

    expect(staleConsultsOf(second)).toEqual([
      { revision: 1, action: 'rewrite-task' },
      { revision: 2, action: 'rewrite-task' },
    ]);
    expect(taskIn(second, 'T002').revision).toBe(3);
  });

  it('never consults a task whose recorded inputs are untouched', async () => {
    const { projectDir, sessionId } = setupProject({ 'src/shared.ts': SHARED });
    const task = staleTask(projectDir);
    const state = implementingState([task, trailingTask()]);
    const typed = consultCallAnswering(() => guidanceAnswer('Never sent.'));
    const planner = makePlanner({ typedCall: typed });

    await runForTask({ projectDir, sessionId, task, state, planner });

    expect(typed).not.toHaveBeenCalled();
  });

  it('applies a stale rewrite without a rollback and dispatches the new revision once', async () => {
    const { projectDir, sessionId } = setupProject({
      'src/shared.ts': SHARED,
      'src/other.ts': OTHER,
    });
    const task = staleTask(projectDir);
    const state = implementingState([task, trailingTask()]);
    const typed = consultCallAnswering(() => staleRewriteAnswer());
    const planner = makePlanner({ typedCall: typed });
    const implementer = makeImplementer();
    const { bus, events } = makeBusRecorder();
    writeFileSync(join(projectDir, 'src/shared.ts'), EDITED_SHARED);
    writeFileSync(join(projectDir, 'src/other.ts'), EDITED_OTHER);

    const result = await runForTask({
      projectDir,
      sessionId,
      task,
      state,
      planner,
      implementer,
      bus,
    });

    const rewritten = taskIn(result, 'T002');
    expect(rewritten.revision).toBe(2);
    expect(rewritten.description).toBe(
      makeTaskSpec({ suggestedFiles: ['src/b.ts'], contextFiles: ['src/shared.ts'] }).intent,
    );
    expect(rewritten.inputHashes?.['src/shared.ts']).toBe(
      inputHashesNow(projectDir, ['src/shared.ts'])['src/shared.ts'],
    );
    expect(staleConsultsOf(result)).toEqual([{ revision: 1, action: 'rewrite-task' }]);

    // No attempt ran, so the rewrite rolls nothing back: an unrelated dirty file
    // keeps its contents, and no rollback warning is published.
    expect(readFileSync(join(projectDir, 'src/other.ts'), 'utf8')).toBe(EDITED_OTHER);
    expect(events.filter((event) => event.type === 'warning')).toHaveLength(0);

    // The replacement is dispatched exactly once, on revision 2; T003 is untouched.
    expect(implementer.implement).toHaveBeenCalledTimes(1);
    const dispatched = vi.mocked(implementer.implement).mock.calls[0]?.[0];
    expect(dispatched?.task.id).toBe('T002');
    expect(dispatched?.task.revision).toBe(2);
    expect(taskIn(result, 'T003').status).toBe('pending');
  });

  it('frames the first attempt with the stale guidance', async () => {
    const { projectDir, sessionId } = setupProject({ 'src/shared.ts': SHARED });
    const task = staleTask(projectDir);
    const state = implementingState([task, trailingTask()]);
    const typed = consultCallAnswering(() => guidanceAnswer('Read the new shared file first.'));
    const planner = makePlanner({ typedCall: typed });
    const implementer = makeImplementer();
    writeFileSync(join(projectDir, 'src/shared.ts'), EDITED_SHARED);

    await runForTask({ projectDir, sessionId, task, state, planner, implementer });

    expect(implementer.implement).not.toHaveBeenCalled();
    expect(implementer.retry).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 1,
        error: expect.stringContaining('## Guidance from the planner:'),
      }),
    );
    expect(implementer.retry).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('Read the new shared file first.'),
      }),
    );
  });

  it.each(guardCases)(
    'retries the $seat stale consult before dispatch until its $violation guard question is answered',
    async ({ seat, violation }) => {
      const { projectDir, sessionId, task, state } = setupGuardQuestion(seat);
      const typed = consultCallAnswering(() =>
        staleRewriteAnswer(violation === 'criteria' ? ['C1', 'C2'] : ['C1']),
      );
      const otherSeat = makePlanner();
      const planner = seat === 'plan' ? makePlanner({ typedCall: typed }) : otherSeat;
      const reviewer = seat === 'review' ? makePlanner({ typedCall: typed }) : otherSeat;
      const implementer = makeImplementer();
      const onPlannerReply = vi.fn().mockResolvedValue(undefined);
      writeFileSync(join(projectDir, 'src/shared.ts'), EDITED_SHARED);

      const result = await runForTask({
        projectDir,
        sessionId,
        task,
        state,
        planner,
        reviewer,
        implementer,
        callbacks: makeCallbacks({ onPlannerReply }).callbacks,
      });

      expect(onPlannerReply).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          seat,
          text: expect.stringContaining(
            `SPLITBRIEF asked the ${seat === 'review' ? 'reviewer' : 'planner'} to fix T002`,
          ),
          questions: [
            expect.objectContaining({
              text: expect.stringContaining(
                violation === 'criteria'
                  ? 'the rewritten task changes its criteria'
                  : 'the rewritten task drops the checks its criteria require: K2',
              ),
            }),
          ],
          answered: false,
        }),
      );
      expect(result.pendingRecovery).toMatchObject({
        reason: 'planner-call-failed',
        seat,
        taskId: task.id,
        message: expect.stringContaining(
          `The ${seat === 'review' ? 'reviewer' : 'planner'}'s question remains unanswered.`,
        ),
      });
      expect(loadState({ projectDir, sessionId })?.pendingRecovery).toEqual(result.pendingRecovery);
      expect(taskIn(result, 'T002').revision).toBeUndefined();
      expect(taskIn(result, 'T002').criteria).toEqual(task.criteria);
      expect(taskIn(result, 'T002').inputHashes).toEqual(task.inputHashes);
      expect(loadState({ projectDir, sessionId })?.tasks[0]?.inputHashes).toEqual(task.inputHashes);
      expect(implementer.implement).not.toHaveBeenCalled();
      expect(implementer.retry).not.toHaveBeenCalled();

      const retryOptions = {
        projectDir,
        sessionId,
        task,
        state: result,
        planner,
        reviewer,
        implementer,
        callbacks: makeCallbacks({ onPlannerReply }).callbacks,
      };
      const unanswered = await retryStaleTask(retryOptions);
      const runner = seat === 'review' ? 'reviewer' : 'planner';
      expect(typed.mock.calls.map(([ctx]) => ctx.seat)).toEqual([runner, runner]);
      expect(onPlannerReply).toHaveBeenCalledTimes(2);
      expect(unanswered.pendingRecovery).toMatchObject({
        reason: 'planner-call-failed',
        seat,
        taskId: task.id,
      });
      expect(loadState({ projectDir, sessionId })?.pendingRecovery).toEqual(
        unanswered.pendingRecovery,
      );
      expect(taskIn(unanswered, task.id).inputHashes).toEqual(task.inputHashes);
      expect(loadState({ projectDir, sessionId })?.tasks[0]?.inputHashes).toEqual(task.inputHashes);
      expect(unanswered.lineages?.T002?.staleConsultedRevision).toEqual({});
      expect(implementer.implement).not.toHaveBeenCalled();
      expect(implementer.retry).not.toHaveBeenCalled();

      const answer = 'Keep C1 and read the new shared file before implementation.';
      onPlannerReply.mockImplementation(async () => {
        expect(loadState({ projectDir, sessionId })?.tasks[0]?.inputHashes).toEqual(
          task.inputHashes,
        );
        expect(implementer.implement).not.toHaveBeenCalled();
        expect(implementer.retry).not.toHaveBeenCalled();
        return answer;
      });
      const resolved = await retryStaleTask({ ...retryOptions, state: unanswered });
      expect(typed.mock.calls.map(([ctx]) => ctx.seat)).toEqual([runner, runner, runner]);
      expect(otherSeat.typedCall).not.toHaveBeenCalled();
      expect(resolved.pendingRecovery).toBeUndefined();
      expect(taskIn(resolved, task.id).inputHashes).toEqual(
        inputHashesNow(projectDir, ['src/b.ts', 'src/shared.ts']),
      );
      expect(resolved.lineages?.T002?.staleConsultedRevision).toEqual({ T002: 1 });
      expect(implementer.implement).not.toHaveBeenCalled();
      expect(implementer.retry).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ attempt: 1, error: expect.stringContaining(answer) }),
      );
    },
  );

  it.each(['plan', 'review'] as const)(
    'retries a thrown stale consult on %s before any dispatch',
    async (seat) => {
      const { projectDir, sessionId, task, state } = setupGuardQuestion(seat);
      const implementer = makeImplementer();
      let answered = false;
      const typed = consultCallAnswering(() => {
        expect(implementer.implement).not.toHaveBeenCalled();
        expect(implementer.retry).not.toHaveBeenCalled();
        if (!answered) throw new Error('The stale consult process stopped unexpectedly.');
        return guidanceAnswer('Read the new shared file first.');
      });
      const otherSeat = makePlanner();
      const planner = seat === 'plan' ? makePlanner({ typedCall: typed }) : otherSeat;
      const reviewer = seat === 'review' ? makePlanner({ typedCall: typed }) : otherSeat;
      writeFileSync(join(projectDir, 'src/shared.ts'), EDITED_SHARED);
      const options = { projectDir, sessionId, task, state, planner, reviewer, implementer };
      const halted = await runForTask(options);

      expect(halted.pendingRecovery).toMatchObject({
        reason: 'planner-call-failed',
        seat,
        taskId: task.id,
      });
      expect(loadState({ projectDir, sessionId })?.pendingRecovery).toEqual(halted.pendingRecovery);
      expect(taskIn(halted, task.id).inputHashes).toEqual(task.inputHashes);
      expect(loadState({ projectDir, sessionId })?.tasks[0]?.inputHashes).toEqual(task.inputHashes);
      expect(implementer.implement).not.toHaveBeenCalled();
      expect(implementer.retry).not.toHaveBeenCalled();

      answered = true;
      const resolved = await retryStaleTask({ ...options, state: halted });
      const runner = seat === 'review' ? 'reviewer' : 'planner';
      expect(typed.mock.calls.map(([ctx]) => ctx.seat)).toEqual([runner, runner]);
      expect(otherSeat.typedCall).not.toHaveBeenCalled();
      expect(resolved.pendingRecovery).toBeUndefined();
      expect(taskIn(resolved, task.id).inputHashes).toEqual(
        inputHashesNow(projectDir, ['src/b.ts', 'src/shared.ts']),
      );
      expect(resolved.lineages?.T002?.staleConsultedRevision).toEqual({ T002: 1 });
      expect(implementer.implement).not.toHaveBeenCalled();
      expect(implementer.retry).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          attempt: 1,
          error: expect.stringContaining('Read the new shared file first.'),
        }),
      );
    },
  );

  it.each(guardCases)(
    'dispatches its first attempt with the operator answer and fresh hashes after a $seat $violation guard question',
    async ({ seat, violation }) => {
      const { projectDir, sessionId, task, state } = setupGuardQuestion(seat);
      const typed = consultCallAnswering(() =>
        staleRewriteAnswer(violation === 'criteria' ? ['C1', 'C2'] : ['C1']),
      );
      const planner = makePlanner({ typedCall: typed });
      const implementer = makeImplementer();
      const answer = 'Keep C1 and read the new shared file before implementation.';
      const onPlannerReply = vi.fn(async () => {
        expect(loadState({ projectDir, sessionId })?.tasks[0]?.inputHashes).toEqual(
          task.inputHashes,
        );
        expect(implementer.implement).not.toHaveBeenCalled();
        expect(implementer.retry).not.toHaveBeenCalled();
        return {
          text: `How should T002 proceed?\n${answer}`,
          qa: [{ question: 'How should T002 proceed?', answer }],
        };
      });
      const { bus, events } = makeBusRecorder();
      writeFileSync(join(projectDir, 'src/shared.ts'), EDITED_SHARED);

      const result = await runForTask({
        projectDir,
        sessionId,
        task,
        state,
        planner,
        implementer,
        bus,
        callbacks: makeCallbacks({ onPlannerReply }).callbacks,
      });

      expect(onPlannerReply).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          seat,
          questions: [
            expect.objectContaining({ text: expect.stringContaining('How should T002 proceed?') }),
          ],
        }),
      );
      expect(result.pendingRecovery).toBeUndefined();
      expect(taskIn(result, 'T002').revision).toBeUndefined();
      expect(taskIn(result, 'T002').criteria).toEqual(task.criteria);
      expect(taskIn(result, 'T002').inputHashes).toEqual(
        inputHashesNow(projectDir, ['src/b.ts', 'src/shared.ts']),
      );
      expect(implementer.implement).not.toHaveBeenCalled();
      expect(implementer.retry).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ attempt: 1, error: expect.stringContaining(answer) }),
      );
      const firstAttempt = vi.mocked(implementer.retry).mock.calls[0]?.[0];
      expect(firstAttempt?.error).toContain(
        `## Guidance from the ${seat === 'review' ? 'reviewer' : 'planner'}:`,
      );
      expect(firstAttempt?.error).not.toContain('How should T002 proceed?');
      expect(events.filter((event) => event.type === 'user_message')).toEqual([
        expect.objectContaining({ text: answer, qa: [expect.objectContaining({ answer })] }),
      ]);
    },
  );
});
