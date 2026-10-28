import {
  CONSULT_ANSWER_JSON_SCHEMA,
  STALE_CONSULT_ANSWER_JSON_SCHEMA,
  consultAnswerSchemaFor,
  type ConsultAnswer,
  type ConsultReason,
  type ConsultSeat,
  type ImplementerReport,
} from '../../../core/schemas/consult.js';
import type { Config } from '../../../core/schemas/config.js';
import { resolveReviewerRunner } from '../../../core/config/accessors/reviewer-runner.js';
import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import { lineageIdOf, nextTaskIds } from '../../../core/state/task-insert.js';
import { isInDeclaredSet } from '../../../core/scope/declared-set.js';
import { diffFileEntries } from '../../../lib/git/entry-diff.js';
import type { RunnerCallEvent } from '../../calls/types.js';
import type { EventBus } from '../../events/types.js';
import type { Planner } from '../../planners/types.js';
import type { Reviewer } from '../../reviewers/types.js';
import type { RequestTypedResult, SeatProtocolError } from '../../runners/typed-output.js';
import { orderChangedFiles } from '../../change-detection.js';
import { refusedCheckErrors, unconfiguredRenderCheckErrors } from '../../spec/plan-checks.js';
import { buildConsultPrompt, type ConsultPromptInput } from '../../spec/prompts/consult.js';
import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/capture.js';
import { readChangeEntry } from '../approval/file-snapshots/entry.js';
import { entryToRestore } from '../approval/file-snapshots/restore.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { entryStoreDir } from '../isolation/entry-snapshot.js';
import { publishConsultAnswered, publishRunnerCallEvent } from '../events.js';
import { askPlannerSession, type PlannerSessionTurn } from '../planner-session.js';
import { runReviewerCall } from '../review-call.js';
import { runSeatCall, seatFailureFromError } from '../escalation/seat-wait.js';
import { addUsageAndSave, transitionAndSave } from '../state-ops.js';
import { planApprovesNpmScripts } from '../validation/run-checks.js';
import {
  buildStageContext,
  type StageContext,
  unresolvedTestCheckErrors,
} from '../validation/run.js';

export type ConsultContext = Readonly<{
  projectDir: string;
  workspaceDir: string;
  sessionId: string;
  bus: EventBus;
  /** With the state's approval, whether a `cmd` check of a rewrite or split may run an npm script. */
  config: Config;
  planner: Pick<Planner, 'capabilities' | 'typedCall'>;
  /** Answers a fix task's repair consult; with no reviewer block it is the planner itself. */
  reviewer: Pick<Reviewer, 'typedCall'>;
  /** The state the consult runs on; every transition it saves is persisted. */
  state: WorkflowState;
  signal?: AbortSignal | undefined;
  /** Receives the state after each saved transition: a session handle, the record, the count. */
  onStateChange?: ((state: WorkflowState) => void) | undefined;
}>;

export type ConsultRequestInput = Readonly<{
  task: Task;
  reason: ConsultReason;
  failingOutput: string;
  report?: ImplementerReport | null | undefined;
}>;

export type ConsultOutcome =
  | Readonly<{ answer: ConsultAnswer }>
  | Readonly<{ error: SeatProtocolError }>;

/** What one seat-trouble-wrapped consult attempt produced: an answer, or the error to rethrow. */
type ConsultRun =
  | Readonly<{ kind: 'answer'; result: RequestTypedResult<ConsultAnswer> }>
  | Readonly<{ kind: 'threw'; error: unknown }>;

/** The seat whose consult failed, including returned protocol errors the caller throws. */
const thrownSeats = new WeakMap<object, ConsultSeat>();

/** The seat whose consult produced `err`, for a caller that halts on that failure. */
export function thrownConsultSeat(err: unknown): ConsultSeat | undefined {
  return typeof err === 'object' && err !== null ? thrownSeats.get(err) : undefined;
}

/**
 * The seat that answers a consult: the reviewer wrote a fix task at the review, so it
 * decides that task's repair; the planner answers every plan task.
 */
export function consultSeat(task: Task): ConsultSeat {
  return task.fix !== undefined ? 'review' : 'plan';
}

/** The answer contract a consult reason takes: stale narrows the actions. */
function reasonContract(task: Task, reason: ConsultReason) {
  if (reason === 'stale') {
    return {
      schema: consultAnswerSchemaFor(task, 'stale'),
      jsonSchema: STALE_CONSULT_ANSWER_JSON_SCHEMA,
      schemaName: 'stale_consult_answer',
    };
  }
  return {
    schema: consultAnswerSchemaFor(task),
    jsonSchema: CONSULT_ANSWER_JSON_SCHEMA,
    schemaName: 'consult_answer',
  };
}

/**
 * The answer contract of one consult. A rewrite or a split never brings in a `cmd` check that the
 * plan command policy refuses or whose npm script no one adds, a `render` check that names no
 * scenario id or that the run cannot render, or a `test` check whose value is not one test file in
 * the workspace or in the files of the answer or of a pending task: the answer fails the schema and the
 * seat gets its one repair.
 */
function answerContract(
  task: Task,
  reason: ConsultReason,
  checks: {
    npmScriptsApproved: boolean;
    projectDir: string;
    renderCommand: string | undefined;
    testChecks: StageContext;
    pendingFiles: readonly string[];
  },
) {
  const contract = reasonContract(task, reason);
  return {
    ...contract,
    schema: contract.schema.superRefine((value, ctx) => {
      const specs =
        value.answer.action === 'rewrite-task'
          ? [value.answer.task]
          : value.answer.action === 'split-task'
            ? value.answer.tasks
            : [];
      const specChecks = specs.flatMap((spec) => spec.checks);
      for (const message of [
        ...refusedCheckErrors(specChecks, {
          npmScriptsApproved: checks.npmScriptsApproved,
          projectDir: checks.projectDir,
          writtenFiles: [...checks.pendingFiles, ...specs.flatMap((spec) => spec.suggestedFiles)],
        }).map((error) => error.message),
        ...unconfiguredRenderCheckErrors(specChecks, checks.renderCommand),
        ...unresolvedTestCheckErrors(specs, checks.testChecks, checks.pendingFiles),
      ]) {
        ctx.addIssue({ code: 'custom', message });
      }
    }),
  };
}

async function taskFileDiff(
  projectDir: string,
  snapshot: ChangedFilesSnapshot,
  file: string,
  ref: SessionRef,
): Promise<string> {
  try {
    const before = await entryToRestore(projectDir, snapshot, file, entryStoreDir(ref));
    const after = await readChangeEntry(projectDir, file);
    return await diffFileEntries({
      path: file,
      before: before.kind === 'absent' ? null : before,
      after: after.kind === 'absent' ? null : after,
    });
  } catch {
    // The diff is context for the answer; a file that cannot be read must not stop the call.
    return '';
  }
}

/**
 * The task's diff: what is on disk now against the lineage's start, the workspace when its
 * first brief dispatched. It holds every attempt, revision and split subtask of the task. The
 * brief's own files are diffed, in the brief's order; every other changed file is only named.
 * Null when no start is recorded (a task not dispatched yet, or an older state).
 */
async function taskDiff(
  projectDir: string,
  state: WorkflowState,
  task: Task,
  ref: SessionRef,
): Promise<ConsultPromptInput['taskDiff']> {
  const start = state.lineages?.[lineageIdOf(task)]?.startSnapshot;
  if (start === undefined) return null;
  let files: string[];
  try {
    files = await getChangedFilesSinceSnapshot(projectDir, start);
  } catch {
    // The diff is context for the answer; a workspace that cannot be read must not stop the call.
    return null;
  }
  const briefFiles = files.filter((file) => isInDeclaredSet(file, task.suggestedFiles));
  const diffs: { path: string; diff: string }[] = [];
  for (const file of orderChangedFiles(briefFiles, task.suggestedFiles)) {
    const diff = await taskFileDiff(projectDir, start, file, ref);
    if (diff !== '') diffs.push({ path: file, diff });
  }
  return { diffs, otherFiles: files.filter((file) => !briefFiles.includes(file)) };
}

function promptInput(
  state: WorkflowState,
  input: ConsultRequestInput,
  taskDiff: ConsultPromptInput['taskDiff'],
  workspaceDir: string,
  seat: ConsultSeat,
): ConsultPromptInput {
  const lineage = state.lineages?.[lineageIdOf(input.task)];
  return {
    workspaceDir,
    seat,
    reason: input.reason,
    plan: state.plan,
    task: input.task,
    revisions: lineage?.replacedParents ?? [],
    taskDiff,
    failedAttempts: lineage?.attemptFailures ?? [],
    failingOutput: input.failingOutput,
    report: input.report ?? null,
    earlierConsults: lineage?.consultRecords ?? [],
    otherTasks: state.tasks.filter((task) => task.id !== input.task.id),
    operatorInstructions: lineage?.corrections ?? [],
  };
}

/** What the consult answer did, for the transcript: a replacement's new revision, the checks. */
function publishAnswer(
  ctx: ConsultContext,
  state: WorkflowState,
  input: ConsultRequestInput,
  answer: ConsultAnswer,
  seat: ConsultSeat,
): void {
  publishConsultAnswered(
    { bus: ctx.bus, phase: state.phase },
    {
      taskId: input.task.id,
      reason: input.reason,
      seat,
      action: answer.answer.action,
      diagnosis: answer.answer.diagnosis,
      newTaskIds:
        answer.answer.action === 'split-task'
          ? nextTaskIds(state.tasks, answer.answer.tasks.length)
          : null,
      ...(answer.answer.action === 'rewrite-task' && {
        revision: (input.task.revision ?? 1) + 1,
      }),
      ...(answer.answer.action === 'verify' && { checkIds: answer.answer.checkIds }),
    },
  );
}

/**
 * Asks the consult seat about one task and records its answer: the reviewer for a fix
 * task's repair, the planner for the rest (`consultSeat`). The planner continues its
 * session; the reviewer holds none and reads the full prompt. A stale request spends no
 * consult allowance; both seats share the rest.
 */
export async function requestConsult(
  ctx: ConsultContext,
  input: ConsultRequestInput,
): Promise<ConsultOutcome> {
  const ref = { projectDir: ctx.projectDir, sessionId: ctx.sessionId };
  const usageCtx = { ...ref, bus: ctx.bus };
  let state = ctx.state;
  const apply = (next: WorkflowState): void => {
    state = next;
    ctx.onStateChange?.(next);
  };

  const seat = consultSeat(input.task);
  const diff = await taskDiff(ctx.workspaceDir, ctx.state, input.task, ref);
  const prompt = promptInput(ctx.state, input, diff, ctx.workspaceDir, seat);
  const contract = answerContract(input.task, input.reason, {
    npmScriptsApproved: planApprovesNpmScripts({ config: ctx.config, state: ctx.state }),
    projectDir: ctx.workspaceDir,
    renderCommand: ctx.config.validation.render,
    testChecks: buildStageContext({
      projectDir: ctx.workspaceDir,
      config: ctx.config,
      discoveredValidation: ctx.state.discoveredValidation,
      notices: { bus: ctx.bus, phase: ctx.state.phase },
    }),
    pendingFiles: ctx.state.tasks
      .filter((task) => task.status === 'pending' && task.id !== input.task.id)
      .flatMap((task) => task.suggestedFiles),
  });
  const onCallEvent = (event: RunnerCallEvent): void =>
    publishRunnerCallEvent(
      { bus: ctx.bus, phase: state.phase, rootDir: ctx.projectDir, taskId: input.task.id },
      event,
    );
  const session = {
    ...ref,
    bus: ctx.bus,
    planner: ctx.planner,
    state,
    ...(ctx.signal !== undefined && { signal: ctx.signal }),
    onStateChange: apply,
  };

  // The review seat holds no session and never saw the fix brief's plan thread: it
  // reads the full prompt every time, and its call books its usage on the reviewer.
  const ask = async (signal: AbortSignal): Promise<RequestTypedResult<ConsultAnswer>> => {
    if (seat === 'review') {
      const reviewed = await runReviewerCall({
        ...contract,
        reviewer: ctx.reviewer,
        prompt: buildConsultPrompt({ ...prompt, resumed: false }),
        projectDir: ctx.projectDir,
        workspaceDir: ctx.workspaceDir,
        sessionId: ctx.sessionId,
        bus: ctx.bus,
        state,
        signal,
        onCallEvent,
      });
      apply(reviewed.state);
      return reviewed.result;
    }
    const answer = await askPlannerSession(
      { ...session, state, signal },
      {
        ...contract,
        compose: (turn: PlannerSessionTurn) =>
          buildConsultPrompt({ ...prompt, resumed: turn.onSession }),
        onCallEvent,
      },
    );
    return answer.result;
  };

  // A transient seat failure retries with backoff and a near rate-limit reset
  // is waited out before the same call repeats; a thrown consult failure is
  // carried through the wrapper and rethrown so the ladder keeps its halt.
  const asked = await runSeatCall<ConsultRun>(
    {
      ref: usageCtx,
      state,
      seat,
      runner: seat === 'review' ? resolveReviewerRunner(ctx.config).runner : ctx.config.planner,
      ...(ctx.signal !== undefined && { signal: ctx.signal }),
      onStateChange: apply,
    },
    async (signal) => {
      try {
        const result = await ask(signal);
        const value: ConsultRun = { kind: 'answer', result };
        if ('error' in result) {
          return { ok: false, failure: { message: result.error.message }, value };
        }
        return { ok: true, value };
      } catch (error) {
        return {
          ok: false,
          failure: seatFailureFromError(error),
          value: { kind: 'threw', error },
        };
      }
    },
    // A thrown consult carries no usage, and a protocol answer is not retried.
    () => {},
  );

  if (asked.value.kind === 'threw') {
    const thrown = asked.value.error;
    if (typeof thrown === 'object' && thrown !== null) thrownSeats.set(thrown, seat);
    throw thrown;
  }
  const answer = asked.value;

  // The reviewer call booked its usage already; the planner's books here.
  if ('error' in answer.result) {
    if (seat === 'plan') apply(addUsageAndSave(usageCtx, state, 'planner', answer.result.usage));
    thrownSeats.set(answer.result.error, seat);
    return { error: answer.result.error };
  }

  const consulted = answer.result.value;
  apply(
    transitionAndSave(ref, state, {
      type: 'RECORD_CONSULT',
      taskId: input.task.id,
      revision: input.task.revision ?? 1,
      reason: input.reason,
      answer: consulted,
      seat,
    }),
  );
  // One consult allowance: a reviewer consult spends the same count a planner consult does.
  if (input.reason !== 'stale') {
    apply(transitionAndSave(ref, state, { type: 'COUNT_PLANNER_CALL' }));
  }
  publishAnswer(ctx, state, input, consulted, seat);
  if (seat === 'plan') apply(addUsageAndSave(usageCtx, state, 'planner', answer.result.usage));
  return { answer: consulted };
}
