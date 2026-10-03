import type { Planner } from '../engine/planners/types.js';
import type { Implementer } from '../engine/implementers/types.js';
import type { PreparedExecution } from '../engine/runners/prepared-execution.js';
import { loadOwnerWorkflowState } from '../core/state/resume-hydration.js';
import type { SessionRef } from '../core/types/session-ref.js';
import type { WorkflowState } from '../core/schemas/workflow.js';
import { readSession } from '../core/sessions/io.js';
import { runWorkflow } from '../engine/orchestrator/run/workflow.js';
import { discoverSkills } from '../engine/skill-discovery.js';
import type { SkillMeta } from '../core/skills/types.js';
import {
  GLOBAL_SKILL_SCAN_PATH_LABELS,
  PROJECT_SKILL_SCAN_PATH_LABELS,
} from '../core/skills/scan-paths.js';
import { modelCacheStore } from '../stores/discovery/model-cache/state.js';
import { attachmentsStore } from '../stores/workflow/attachments.js';
import { continuesHeadless, formatResumeCommand } from '../core/recovery/resume-command.js';
import { finalReviewFailedCause } from '../core/recovery/headline.js';
import { formatResetAt } from '../core/recovery/reset-clock.js';
import { cliError } from './errors.js';
import { installTerminalOutputErrorGuard } from '../lib/terminal/control.js';
import { writeHeadlessJsonRecord } from '../engine/events/public-json.js';
import { createQuestionMarkerStripper } from '../engine/parsers/question.js';

function buildNoopSinks() {
  return {
    setAbortHandler: () => undefined,
    setQueueHandler: () => undefined,
  };
}

function loadOwnedState(ref: SessionRef): WorkflowState | null {
  const hydrated = loadOwnerWorkflowState(ref);
  if (hydrated.kind !== 'loaded') return null;
  return hydrated.state;
}

/**
 * `--plain` owns the same stdout, so the NDJSON records below are written only
 * for the JSON rendering. Every one of them is followed by a thrown `cliError`,
 * whose message carries the same fact to stderr in both modes.
 */
type RecordWriter = typeof writeHeadlessJsonRecord;

const NO_RECORD: RecordWriter = () => undefined;

export function recordWriterFor(plain: boolean): RecordWriter {
  return plain ? NO_RECORD : writeHeadlessJsonRecord;
}

export function emitRecoveryAndFailIfPending({
  state,
  sessionId,
  writeRecord,
}: {
  state: WorkflowState | null;
  sessionId: string;
  writeRecord: RecordWriter;
}): void {
  const conversation = state?.pendingPlannerConversation;
  if (
    conversation !== undefined &&
    !conversation.answered &&
    state?.pendingRecovery === undefined
  ) {
    const resumeCommand = `splitbrief continue ${sessionId}`;
    const stripper = createQuestionMarkerStripper();
    const visibleText = (stripper.push(conversation.text) + stripper.flush()).trim();
    const message =
      visibleText ||
      conversation.questions
        .map((question) =>
          question.type === 'choice'
            ? `${question.text} (${question.options.join(' / ')})`
            : question.type === 'confirm'
              ? `${question.text} (yes / no)`
              : question.text,
        )
        .join('\n');
    writeRecord(
      {
        type: 'input_required',
        sessionId,
        call: conversation.call,
        message,
        questions: conversation.questions,
        resumeCommand,
      },
      process.stdout,
    );
    throw cliError(`The planner needs your reply.\n${message}\nContinue with: ${resumeCommand}`, 1);
  }
  const issue = state?.pendingRecovery;
  if (!issue) return;
  const resumeCommand = formatResumeCommand(sessionId, issue);
  writeRecord(
    {
      type: 'recovery_required',
      sessionId,
      reason: issue.reason,
      status: issue.status,
      message: issue.message,
      taskId: issue.taskId,
      files: issue.files,
      affectedTaskIds: issue.affectedTaskIds,
      availableActions: issue.availableActions,
      recommendedAction: issue.recommendedAction,
      resumeCommand,
    },
    process.stdout,
  );
  // The stored message names no clock; a quota halt's reset is spelled when the line is printed.
  const reset = formatResetAt(issue.resetAt);
  throw cliError(
    `Recovery required (${issue.reason}): ${issue.message}${reset === undefined ? '' : ` (${reset})`}\nRecommended: ${issue.recommendedAction}\nContinue with: ${resumeCommand}${continuesHeadless(issue) ? ' [--plain|--json]' : ''}`,
    1,
  );
}

function failIfFinalReviewFailed(
  state: WorkflowState | null,
  projectDir: string,
  sessionId: string,
  writeRecord: RecordWriter,
): void {
  if (state?.reviewStatus !== 'failed') return;
  const blocking = readSession({ projectDir, sessionId })?.summary?.review?.critical ?? 0;
  writeRecord({ type: 'final_review_failed', sessionId, blocking });
  throw cliError(`${finalReviewFailedCause(blocking)}; see review.md`, 1);
}

function failIfFinalReviewIncomplete(
  state: WorkflowState | null,
  sessionId: string,
  writeRecord: RecordWriter,
): void {
  if (state?.phase !== 'final-review') return;
  writeRecord({ type: 'final_review_incomplete', sessionId });
  throw cliError('Final review did not pass — workflow is incomplete.', 1);
}

function failIfSessionFailed(
  projectDir: string,
  sessionId: string,
  writeRecord: RecordWriter,
): void {
  const session = readSession({ projectDir, sessionId });
  if (session?.stop !== 'failed') return;
  writeRecord({
    type: 'error',
    message: `Session ${sessionId} ended with status failed.`,
  });
  throw cliError('Workflow failed — see the error output above.', 1);
}

// A run stopped short of completion — a tiered approval refused headlessly, a gate
// that ended the task loop, an operator ending the run — saves the session open or
// ended, without a pendingRecovery and without a failed stop reason, so the guards
// above miss it. A user-requested abort never reaches here: the signal check in
// runHeadless returns first, keeping SIGINT/SIGTERM at exit 0.
function failIfSessionInterrupted(
  projectDir: string,
  sessionId: string,
  writeRecord: RecordWriter,
): void {
  const session = readSession({ projectDir, sessionId });
  if (session === null || session.status === 'complete') return;
  writeRecord({
    type: 'error',
    message: `Session ${sessionId} ended with status ${session.status}.`,
  });
  throw cliError(
    session.status === 'ended'
      ? 'Workflow was cancelled.'
      : 'Workflow did not complete — the run stopped early.',
    1,
  );
}

/**
 * `--skills` names ids, and an id that no scan root carries would otherwise
 * reach the planner as silence. Resolved before preparation so the run fails
 * with the roots it looked in rather than planning without the skill.
 */
export async function resolveSelectedSkills(
  projectDir: string,
  ids: readonly string[] | undefined,
): Promise<SkillMeta[] | undefined> {
  if (ids === undefined || ids.length === 0) return undefined;
  const available = await discoverSkills(projectDir);
  const roots = [...PROJECT_SKILL_SCAN_PATH_LABELS, ...GLOBAL_SKILL_SCAN_PATH_LABELS];
  return ids.map((id) => {
    const skill = available.find((candidate) => candidate.id === id);
    if (skill === undefined) {
      throw cliError(`Unknown skill: ${id} (scanned: ${roots.join(', ')})`, 2);
    }
    return skill;
  });
}

export interface RunHeadlessOptions {
  prepared: PreparedExecution;
  /** `--plain`: render the run as plain lines instead of NDJSON records. */
  plain?: boolean | undefined;
  /** `--skills`: the resolved skills every seat of this run carries. */
  selectedSkills?: SkillMeta[] | undefined;
  _planner?: Planner | undefined;
  _implementer?: Implementer | undefined;
}

export async function runHeadless(options: RunHeadlessOptions): Promise<void> {
  const { prepared, plain, selectedSkills, _planner, _implementer } = options;
  const projectDir = prepared.session.ref.projectDir;
  const sessionId = prepared.session.ref.sessionId;
  installTerminalOutputErrorGuard();
  const writeRecord = recordWriterFor(plain === true);

  // A resumed session with a pending recovery is already an owner-controlled
  // state machine. A headless observation must report it, not manufacture a
  // retry by entering the ordinary workflow loop (which would invoke a
  // planner/provider).
  if (prepared.purpose === 'resume') {
    const preflight = loadOwnedState({ projectDir, sessionId });
    if (preflight !== null) {
      emitRecoveryAndFailIfPending({ state: preflight, sessionId, writeRecord });
    }
  }

  const abortController = new AbortController();
  const onSignal = () => abortController.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    await runWorkflow({
      prepared,
      headless: true,
      sinks: buildNoopSinks(),
      modelCache: modelCacheStore,
      drainPendingAttachments: () => attachmentsStore.drain(),
      signal: abortController.signal,
      ...(plain === true && { plain: true }),
      selectedSkills,
      _planner,
      _implementer,
      savedState: prepared.runtime.resumeState,
      callbacks: {
        onApprovalNeeded: async (_type, _input) => ({ approved: true, unattended: true }),
        onComplete: () => undefined,
      },
    });
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }

  if (abortController.signal.aborted) return;

  const finalState = loadOwnedState({ projectDir, sessionId });
  emitRecoveryAndFailIfPending({ state: finalState, sessionId, writeRecord });
  failIfFinalReviewFailed(finalState, projectDir, sessionId, writeRecord);
  failIfFinalReviewIncomplete(finalState, sessionId, writeRecord);
  failIfSessionFailed(projectDir, sessionId, writeRecord);
  failIfSessionInterrupted(projectDir, sessionId, writeRecord);
}
