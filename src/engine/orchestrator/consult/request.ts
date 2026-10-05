import {
  CONSULT_ANSWER_JSON_SCHEMA,
  DEVIATION_CONSULT_ANSWER_JSON_SCHEMA,
  STALE_CONSULT_ANSWER_JSON_SCHEMA,
  consultAnswerSchemaFor,
  type ConsultAnswer,
  type ConsultReason,
  type ImplementerReport,
} from '../../../core/schemas/consult.js';
import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import { lineageIdOf, nextTaskIds } from '../../../core/state/task-insert.js';
import { diffFileEntries } from '../../../lib/git/entry-diff.js';
import type { RunnerCallEvent } from '../../calls/types.js';
import type { EventBus } from '../../events/types.js';
import type { Planner } from '../../planners/types.js';
import type { SeatProtocolError } from '../../runners/typed-output.js';
import { buildConsultPrompt, type ConsultPromptInput } from '../../spec/prompts/consult.js';
import { readConfinedEntry } from '../approval/file-snapshots/entry.js';
import { entryToRestore } from '../approval/file-snapshots/restore.js';
import { publishConsultAnswered, publishRunnerCallEvent } from '../events.js';
import {
  askPlannerSession,
  type PlannerSessionAnswer,
  type PlannerSessionTurn,
} from '../planner-session.js';
import { runSeatCall, seatFailureFromError } from '../escalation/seat-wait.js';
import { addUsageAndSave, transitionAndSave } from '../state-ops.js';

export type ConsultContext = Readonly<{
  projectDir: string;
  workspaceDir: string;
  sessionId: string;
  bus: EventBus;
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
  /** The attempt's start snapshot; with `changedFiles` it is the diff's before side. */
  snapshot: ChangedFilesSnapshot;
  /** The files the attempt changed since `snapshot`. */
  changedFiles: readonly string[];
}>;

export type ConsultOutcome =
  | Readonly<{ answer: ConsultAnswer }>
  | Readonly<{ error: SeatProtocolError }>;

/** What one seat-trouble-wrapped consult attempt produced: an answer, or the error to rethrow. */
type ConsultRun =
  | Readonly<{ kind: 'answer'; answer: PlannerSessionAnswer<ConsultAnswer> }>
  | Readonly<{ kind: 'threw'; error: unknown }>;

async function attemptFileDiff(
  projectDir: string,
  snapshot: ChangedFilesSnapshot,
  file: string,
): Promise<string> {
  try {
    const before = await entryToRestore(projectDir, snapshot, file);
    const after = await readConfinedEntry(projectDir, file);
    return await diffFileEntries({
      path: file,
      before: before.kind === 'file' ? { bytes: before.bytes, mode: before.mode } : null,
      after: after.kind === 'file' ? { bytes: after.bytes, mode: after.mode } : null,
    });
  } catch {
    // The diff is context for the answer; a file that cannot be read must not stop the call.
    return '';
  }
}

/**
 * The attempt's diff, rendered from its start snapshot and the files it changed: the side
 * recorded for the file at capture, or the commit the attempt started on, against what is on
 * disk now.
 */
async function attemptDiff(
  projectDir: string,
  snapshot: ChangedFilesSnapshot,
  files: readonly string[],
): Promise<string> {
  const diffs: string[] = [];
  for (const file of files) {
    const diff = await attemptFileDiff(projectDir, snapshot, file);
    if (diff !== '') diffs.push(diff);
  }
  return diffs.join('\n');
}

function promptInput(
  state: WorkflowState,
  input: ConsultRequestInput,
  diff: string,
  workspaceDir: string,
): ConsultPromptInput {
  const lineage = state.lineages?.[lineageIdOf(input.task)];
  return {
    workspaceDir,
    reason: input.reason,
    plan: state.plan,
    task: input.task,
    revisions: lineage?.replacedParents ?? [],
    diff,
    failingOutput: input.failingOutput,
    report: input.report ?? null,
    earlierConsults: lineage?.consultRecords ?? [],
    otherTasks: state.tasks.filter((task) => task.id !== input.task.id),
  };
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
 * The run's consult with its planner about one task: the typed call on the planner's session,
 * the answer recorded on the task's lineage, and the planner-call count it spends. The answer
 * is not applied here; the caller moves the task on it.
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

  const diff = await attemptDiff(ctx.workspaceDir, input.snapshot, input.changedFiles);
  const prompt = promptInput(ctx.state, input, diff, ctx.workspaceDir);
  const compose = (turn: PlannerSessionTurn): string =>
    buildConsultPrompt({ ...prompt, resumed: turn.onSession });
  const call = {
    compose,
    onCallEvent: (event: RunnerCallEvent) =>
      publishRunnerCallEvent({ bus: ctx.bus, phase: state.phase }, event),
  };
  const session = {
    ...ref,
    bus: ctx.bus,
    planner: ctx.planner,
    state,
    ...(ctx.signal !== undefined && { signal: ctx.signal }),
    onStateChange: apply,
  };

  // A transient seat failure retries with backoff and a near rate-limit reset
  // is waited out before the same call repeats; a thrown consult failure is
  // carried through the wrapper and rethrown so the ladder keeps its halt.
  const asked = await runSeatCall<ConsultRun>(
    {
      ref: usageCtx,
      state,
      seat: 'plan',
      ...(ctx.signal !== undefined && { signal: ctx.signal }),
      onStateChange: apply,
    },
    async (signal) => {
      const attemptSession = { ...session, state, signal };
      try {
        let answer: PlannerSessionAnswer<ConsultAnswer>;
        if (input.reason === 'stale') {
          answer = await askPlannerSession(attemptSession, {
            ...call,
            schema: consultAnswerSchemaFor(input.task, 'stale'),
            jsonSchema: STALE_CONSULT_ANSWER_JSON_SCHEMA,
            schemaName: 'stale_consult_answer',
          });
        } else if (input.reason === 'deviation') {
          answer = await askPlannerSession(attemptSession, {
            ...call,
            schema: consultAnswerSchemaFor(input.task, 'deviation'),
            jsonSchema: DEVIATION_CONSULT_ANSWER_JSON_SCHEMA,
            schemaName: 'deviation_consult_answer',
          });
        } else {
          answer = await askPlannerSession(attemptSession, {
            ...call,
            schema: consultAnswerSchemaFor(input.task),
            jsonSchema: CONSULT_ANSWER_JSON_SCHEMA,
            schemaName: 'consult_answer',
          });
        }
        const value: ConsultRun = { kind: 'answer', answer };
        if ('error' in answer.result) {
          return { ok: false, failure: { message: answer.result.error.message }, value };
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

  if (asked.value.kind === 'threw') throw asked.value.error;
  const answer = asked.value.answer;

  if ('error' in answer.result) {
    apply(addUsageAndSave(usageCtx, state, 'planner', answer.result.usage));
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
  if (input.reason !== 'stale') {
    apply(transitionAndSave(ref, state, { type: 'COUNT_PLANNER_CALL' }));
  }
  publishAnswer(ctx, state, input, consulted);
  apply(addUsageAndSave(usageCtx, state, 'planner', answer.result.usage));
  return { answer: consulted };
}
