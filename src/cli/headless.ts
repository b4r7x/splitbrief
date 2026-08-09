import type { Planner } from '../engine/planners/types.js';
import type { Implementer } from '../engine/implementers/types.js';
import type { PreparedExecution } from '../engine/runners/prepared-execution.js';
import { loadState } from '../core/state/persistence.js';
import { readSession } from '../core/sessions/io.js';
import { runWorkflow } from '../engine/orchestrator/run/workflow.js';
import { modelCacheStore } from '../stores/discovery/model-cache.js';
import { attachmentsStore } from '../stores/workflow/attachments.js';
import { cliError } from './errors.js';
import { installTerminalOutputErrorGuard } from '../lib/terminal/control.js';
import { flushOtel } from '../lib/otel.js';
import { writeHeadlessJsonRecord } from '../engine/events/public-json.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../core/transcript-policy.js';
import type { Config } from '../core/schemas/config.js';

function buildNoopSinks() {
  return {
    setAbortHandler: () => undefined,
    setQueueHandler: () => undefined,
  };
}

function emitRecoveryAndFailIfPending(
  projectDir: string,
  sessionId: string,
  persistTranscript: boolean,
): void {
  const state = loadState({ projectDir, sessionId });
  const issue = state?.pendingRecovery;
  if (!issue) return;
  writeHeadlessJsonRecord(
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
    { persistTranscript },
  );
  const message = persistTranscript ? issue.message : TRANSCRIPT_OMITTED_MESSAGE;
  const resolutionRoute = issue.availableActions.join(', ');
  throw cliError(
    `Recovery required (status: ${issue.status}): ${message} Resolve it by choosing one of: ${resolutionRoute}.`,
    1,
  );
}

function failIfFinalReviewIncomplete(projectDir: string, sessionId: string): void {
  const state = loadState({ projectDir, sessionId });
  if (state?.phase !== 'final-review') return;
  writeHeadlessJsonRecord({ type: 'final_review_failed', sessionId });
  throw cliError('Final review did not pass — workflow is incomplete.', 1);
}

function failIfSessionFailed(projectDir: string, sessionId: string): void {
  const session = readSession({ projectDir, sessionId });
  if (session?.status !== 'failed') return;
  writeHeadlessJsonRecord({
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
function failIfSessionInterrupted(projectDir: string, sessionId: string): void {
  const session = readSession({ projectDir, sessionId });
  if (session?.status !== 'interrupted') return;
  writeHeadlessJsonRecord({
    type: 'error',
    message: `Session ${sessionId} ended with status interrupted.`,
  });
  throw cliError('Workflow did not complete — the run stopped early.', 1);
}

export interface RunHeadlessOptions {
  prepared: PreparedExecution;
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
  const { prepared, _planner, _implementer } = options;
  const projectDir = prepared.session.ref.projectDir;
  const sessionId = prepared.session.ref.sessionId;
  const runConfig = prepared.config;
  installTerminalOutputErrorGuard();

  assertHeadlessTaskReviewDisabled(runConfig);

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
    await flushOtel();
  }

  if (abortController.signal.aborted) return;

  emitRecoveryAndFailIfPending(projectDir, sessionId, runConfig.workflow.persistTranscript);
  failIfFinalReviewIncomplete(projectDir, sessionId);
  failIfSessionFailed(projectDir, sessionId);
  failIfSessionInterrupted(projectDir, sessionId);
}
