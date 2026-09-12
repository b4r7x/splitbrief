import type { Planner } from '../engine/planners/types.js';
import type { Implementer } from '../engine/implementers/types.js';
import type { PreparedExecution } from '../engine/runners/prepared-execution.js';
import { loadOwnerWorkflowState } from '../core/state/resume-hydration.js';
import type { SessionRef } from '../core/types/session-ref.js';
import type { WorkflowState } from '../core/schemas/workflow.js';
import { readSession } from '../core/sessions/io.js';
import { runWorkflow } from '../engine/orchestrator/run/workflow.js';
import { modelCacheStore } from '../stores/discovery/model-cache/state.js';
import { attachmentsStore } from '../stores/workflow/attachments.js';
import { cliError } from './errors.js';
import { installTerminalOutputErrorGuard } from '../lib/terminal/control.js';
import { writeHeadlessJsonRecord } from '../engine/events/public-json.js';
import type { Config } from '../core/schemas/config.js';

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

function emitRecoveryAndFailIfPending({
  state,
  sessionId,
  writeRecord,
}: {
  state: WorkflowState | null;
  sessionId: string;
  writeRecord: RecordWriter;
}): void {
  const issue = state?.pendingRecovery;
  if (!issue) return;
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
    },
    process.stdout,
  );
  const resolutionRoute = issue.availableActions.join(', ');
  throw cliError(
    `Recovery required (status: ${issue.status}): ${issue.message} Resolve it by choosing one of: ${resolutionRoute}.`,
    1,
  );
}

function failIfFinalReviewIncomplete(
  state: WorkflowState | null,
  sessionId: string,
  writeRecord: RecordWriter,
): void {
  if (state?.phase !== 'final-review') return;
  writeRecord({ type: 'final_review_failed', sessionId });
  throw cliError('Final review did not pass — workflow is incomplete.', 1);
}

function failIfSessionFailed(
  projectDir: string,
  sessionId: string,
  writeRecord: RecordWriter,
): void {
  const session = readSession({ projectDir, sessionId });
  if (session?.status !== 'failed') return;
  writeRecord({
    type: 'error',
    message: `Session ${sessionId} ended with status failed.`,
  });
  throw cliError('Workflow failed — see the error output above.', 1);
}

// A run stopped short of completion — a tiered approval refused headlessly, a
// gate that ended the task loop — saves the session as 'interrupted' without a
// pendingRecovery and without a 'failed' status, so the guards above miss it.
// A user-requested abort never reaches here: the signal check in runHeadless
// returns first, keeping SIGINT/SIGTERM at exit 0.
function failIfSessionInterrupted(
  projectDir: string,
  sessionId: string,
  writeRecord: RecordWriter,
): void {
  const session = readSession({ projectDir, sessionId });
  if (session?.status !== 'interrupted') return;
  writeRecord({
    type: 'error',
    message: `Session ${sessionId} ended with status interrupted.`,
  });
  throw cliError('Workflow did not complete — the run stopped early.', 1);
}

export interface RunHeadlessOptions {
  prepared: PreparedExecution;
  /** `--plain`: render the run as plain lines instead of NDJSON records. */
  plain?: boolean | undefined;
  _planner?: Planner | undefined;
  _implementer?: Implementer | undefined;
}

export function assertHeadlessTaskReviewDisabled(config: Pick<Config, 'workflow'>): void {
  if ((config.workflow.taskReview ?? 'none') === 'none') return;
  throw cliError(
    'workflow.taskReview requires an interactive TUI run. Set workflow.taskReview: none for headless mode.',
  );
}

export async function runHeadless(options: RunHeadlessOptions): Promise<void> {
  const { prepared, plain, _planner, _implementer } = options;
  const projectDir = prepared.session.ref.projectDir;
  const sessionId = prepared.session.ref.sessionId;
  const runConfig = prepared.config;
  installTerminalOutputErrorGuard();

  assertHeadlessTaskReviewDisabled(runConfig);
  const writeRecord: RecordWriter = plain === true ? NO_RECORD : writeHeadlessJsonRecord;

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
      _planner,
      _implementer,
      savedState: prepared.runtime.resumeState,
      callbacks: {
        onApprovalNeeded: async (_type, _input) => ({ approved: true }),
        onQuestionAsked: async () => '',
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
  failIfFinalReviewIncomplete(finalState, sessionId, writeRecord);
  failIfSessionFailed(projectDir, sessionId, writeRecord);
  failIfSessionInterrupted(projectDir, sessionId, writeRecord);
}
