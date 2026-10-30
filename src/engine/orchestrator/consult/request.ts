import {
  CONSULT_ANSWER_JSON_SCHEMA,
  consultAnswerSchemaFor,
  type ConsultAnswer,
  type ConsultReason,
  type ImplementerReport,
} from '../../../core/schemas/consult.js';
import type { Config } from '../../../core/schemas/config.js';
import type { TriageResult } from '../../../core/schemas/review.js';
import type { Task, TaskId } from '../../../core/schemas/task.js';
import { plannerFixWork, stuckAnswerErrors } from '../../../core/review/stuck.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import { lineageIdOf, nextTaskIds } from '../../../core/state/task-insert.js';
import { isInDeclaredSet } from '../../../core/scope/declared-set.js';
import { diffFileEntries } from '../../../lib/git/entry-diff.js';
import type { RunnerCallEvent } from '../../calls/types.js';
import type { EventBus } from '../../events/types.js';
import type { Planner } from '../../planners/types.js';
import type { RequestTypedResult, SeatProtocolError } from '../../runners/typed-output.js';
import { orderChangedFiles } from '../../change-detection.js';
import { refusedCheckErrors, unconfiguredRenderCheckErrors } from '../../spec/plan-checks.js';
import { buildConsultPrompt, type ConsultPromptInput } from '../../spec/prompts/consult.js';
import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/capture.js';
import { readChangeEntry } from '../approval/file-snapshots/entry.js';
import { entryToRestore } from '../approval/file-snapshots/restore.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { entryStoreDir } from '../isolation/entry-snapshot.js';
import { runBaseOf } from '../isolation/base-tree.js';
import { resolveRunUniverse, runUserFiles } from '../evidence/review-packet/sections-io.js';
import { fixTaskTargetErrors } from '../triage.js';
import { publishConsultAnswered, publishRunnerCallEvent } from '../events.js';
import { askPlannerSession, type PlannerSessionTurn } from '../planner-session.js';
import { runSeatCall, seatFailureFromError } from '../escalation/seat-wait.js';
import { addUsageAndSave, transitionAndSave } from '../state-ops.js';
import {
  checkRegistry,
  enabledReviewChecks,
  planApprovesNpmScripts,
} from '../validation/run-checks.js';
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
  /**
   * A stuck review's consult: the reviewer's next fix work, which the answer reshapes, the ids of
   * the blockers that did not move, and the red checks and Apply conflicts that block.
   */
  stuck?:
    | Readonly<{
        fixWork: TriageResult;
        blockerIds: readonly string[];
        redInputs: readonly string[];
      }>
    | undefined;
}>;

export type ConsultOutcome =
  | Readonly<{ answer: ConsultAnswer }>
  | Readonly<{ error: SeatProtocolError }>;

/** What one seat-trouble-wrapped consult attempt produced: an answer, or the error to rethrow. */
type ConsultRun =
  | Readonly<{ kind: 'answer'; result: RequestTypedResult<ConsultAnswer> }>
  | Readonly<{ kind: 'threw'; error: unknown }>;

/** The failures a consult produced, including returned protocol errors the caller throws. */
const consultErrors = new WeakSet<object>();

/** Whether `err` came out of a consult, for a caller that halts on that failure. */
export function isConsultError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && consultErrors.has(err);
}

/**
 * The answer contract of one consult. A rewrite or a split never brings in a `cmd` check that the
 * plan command policy refuses or whose npm script no one adds, a `render` check that names no
 * scenario id or that the run cannot render, or a `test` check whose value is not one test file in
 * the workspace or in the files of the answer or of a pending task. A fix task's rewrite or split
 * never targets the user's own files the run left alone, and a stuck review's answer meets
 * `stuckAnswerErrors`. Such an answer fails the schema and the seat gets its one repair.
 */
function answerContract(
  task: Task,
  reason: ConsultReason,
  stuck: ConsultRequestInput['stuck'],
  checks: {
    known: ReadonlySet<string>;
    npmScriptsApproved: boolean;
    projectDir: string;
    renderCommand: string | undefined;
    testChecks: StageContext;
    pendingFiles: readonly string[];
    userFiles: ReadonlySet<string>;
  },
) {
  return {
    jsonSchema: CONSULT_ANSWER_JSON_SCHEMA,
    schemaName: 'consult_answer',
    schema: consultAnswerSchemaFor(task, reason).superRefine((value, ctx) => {
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
        ...fixTaskTargetErrors(specs, checks.userFiles),
        ...(stuck === undefined
          ? []
          : stuckAnswerErrors(value.answer, { ...stuck, knownChecks: checks.known })),
      ]) {
        ctx.addIssue({ code: 'custom', message });
      }
    }),
  };
}

/**
 * The user's own files the run left alone, which a fix task never targets. The answer's specs are
 * fix tasks when the task is one or when a stuck review asks, whatever its target. A plan task's
 * consult keeps no files out, and neither does an older run that recorded no files changed when it
 * started: the final review refuses that run with its own error.
 */
async function consultUserFiles(
  ctx: ConsultContext,
  input: ConsultRequestInput,
): Promise<ReadonlySet<string>> {
  const baseline = ctx.state.changedFilesBaseline;
  if (input.task.fix === undefined && input.stuck === undefined) return new Set();
  if (baseline?.runStartChangedFiles === undefined) return new Set();
  return runUserFiles(
    await resolveRunUniverse({
      workspaceDir: ctx.workspaceDir,
      baseline,
      runBase: runBaseOf(ctx, ctx.state),
    }),
  );
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
): ConsultPromptInput {
  const lineage = state.lineages?.[lineageIdOf(input.task)];
  return {
    workspaceDir,
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

/** The ids of the briefs the answer adds: a split's, or the next fix cycle of a stuck review. */
function answerTaskIds(
  state: WorkflowState,
  input: ConsultRequestInput,
  answer: ConsultAnswer,
): TaskId[] | null {
  const action = answer.answer;
  const count =
    input.stuck !== undefined
      ? action.action === 'accept' || action.action === 'cannot'
        ? 0
        : plannerFixWork(input.stuck.fixWork, action, input.stuck.blockerIds).fixTasks.length
      : action.action === 'split-task'
        ? action.tasks.length
        : 0;
  return count === 0 ? null : nextTaskIds(state.tasks, count);
}

/** What the consult answer did, for the transcript: a replacement's new revision, the checks. */
function publishAnswer(
  ctx: ConsultContext,
  state: WorkflowState,
  input: ConsultRequestInput,
  answer: ConsultAnswer,
): void {
  publishConsultAnswered(
    { bus: ctx.bus, phase: state.phase },
    {
      taskId: input.task.id,
      reason: input.reason,
      action: answer.answer.action,
      diagnosis: answer.answer.diagnosis,
      newTaskIds: answerTaskIds(state, input, answer),
      ...(answer.answer.action === 'rewrite-task' &&
        input.stuck === undefined && {
          revision: (input.task.revision ?? 1) + 1,
        }),
      ...(answer.answer.action === 'verify' && { checkIds: answer.answer.checkIds }),
      ...(answer.answer.action === 'accept' && { note: answer.answer.note }),
    },
  );
}

/**
 * Asks the planner about one task, a plan task or a fix task the review wrote, and records its
 * answer. The planner continues its session.
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

  const diff = await taskDiff(ctx.workspaceDir, ctx.state, input.task, ref);
  const prompt = promptInput(ctx.state, input, diff, ctx.workspaceDir);
  const contract = answerContract(input.task, input.reason, input.stuck, {
    known: new Set(
      checkRegistry({
        plan: ctx.state.plan,
        tasks: ctx.state.tasks,
        reviewChecks: enabledReviewChecks(ctx.config, ctx.state.plan),
      }).keys(),
    ),
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
    userFiles: await consultUserFiles(ctx, input),
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

  // A fix task's brief comes from the review, not from the planning thread, so every consult on a
  // fix lineage sends the whole prompt, also on a live session.
  const repair = input.task.fix !== undefined && input.stuck === undefined;
  const ask = async (signal: AbortSignal): Promise<RequestTypedResult<ConsultAnswer>> => {
    const answer = await askPlannerSession(
      { ...session, state, signal },
      {
        ...contract,
        compose: (turn: PlannerSessionTurn) =>
          buildConsultPrompt({ ...prompt, resumed: turn.onSession && !repair }),
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
      seat: 'plan',
      runner: ctx.config.planner,
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
    if (typeof thrown === 'object' && thrown !== null) consultErrors.add(thrown);
    throw thrown;
  }
  const answer = asked.value;

  if ('error' in answer.result) {
    apply(addUsageAndSave(usageCtx, state, 'planner', answer.result.usage));
    consultErrors.add(answer.result.error);
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
    }),
  );
  publishAnswer(ctx, state, input, consulted);
  apply(addUsageAndSave(usageCtx, state, 'planner', answer.result.usage));
  return { answer: consulted };
}
