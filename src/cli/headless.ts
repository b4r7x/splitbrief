import type { WorkflowOpts } from '../core/types/config-options.js';
import type { WorkflowState } from '../core/schemas/workflow.js';
import type { Planner } from '../engine/planners/types.js';
import type { Implementer } from '../engine/implementers/types.js';
import type { CliStartGates } from '../engine/runners/start-gate.js';
import { loadState } from '../core/state/persistence.js';
import { readActive } from '../core/sessions/lifecycle.js';
import { configForSessionTranscriptPolicy, readSession } from '../core/sessions/io.js';
import { runWorkflow } from '../engine/orchestrator/run/workflow.js';
import { modelCacheStore } from '../stores/discovery/model-cache.js';
import { attachmentsStore } from '../stores/workflow/attachments.js';
import { cliError } from './errors.js';
import { resolveRunConfig } from './build-overrides.js';
import { installTerminalOutputErrorGuard } from '../lib/terminal/control.js';
import { flushOtel } from '../lib/otel.js';
import { writeHeadlessJsonRecord } from '../engine/events/public-json.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../core/transcript-policy.js';

function buildNoopSinks() {
  return {
    setAbortHandler: () => undefined,
    setQueueHandler: () => undefined,
  };
}

function emitRecoveryAndFailIfPending(
  projectDir: string,
  sessionId: string | undefined,
  persistTranscript: boolean,
): void {
  const recoverySessionId = sessionId ?? readActive(projectDir);
  if (!recoverySessionId) return;
  const state = loadState({ projectDir, sessionId: recoverySessionId });
  const issue = state?.pendingRecovery;
  if (!issue) return;
  if (issue.status !== 'awaiting-user') return;
  writeHeadlessJsonRecord(
    {
      type: 'recovery_required',
      sessionId: recoverySessionId,
      reason: issue.reason,
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
  throw cliError(`Recovery required: ${message}`, 1);
}

function failIfFinalReviewIncomplete(projectDir: string, sessionId: string | undefined): void {
  const reviewSessionId = sessionId ?? readActive(projectDir);
  if (!reviewSessionId) return;
  const state = loadState({ projectDir, sessionId: reviewSessionId });
  if (state?.phase !== 'final-review') return;
  writeHeadlessJsonRecord({ type: 'final_review_failed', sessionId: reviewSessionId });
  throw cliError('Final review did not pass — workflow is incomplete.', 1);
}

function failIfSessionFailed(projectDir: string, sessionId: string | undefined): void {
  const failedSessionId = sessionId ?? readActive(projectDir);
  if (!failedSessionId) return;
  const session = readSession({ projectDir, sessionId: failedSessionId });
  if (session?.status !== 'failed') return;
  writeHeadlessJsonRecord({
    type: 'error',
    message: `Session ${failedSessionId} ended with status failed.`,
  });
  throw cliError('Workflow failed — see the error output above.', 1);
}

export interface RunHeadlessOptions {
  feature: string;
  projectDir: string;
  opts: WorkflowOpts;
  savedState?: WorkflowState | undefined;
  sessionId?: string | undefined;
  _planner?: Planner | undefined;
  _implementer?: Implementer | undefined;
  plannerContext?: string | undefined;
  trustedCliGates?: CliStartGates | undefined;
}

export async function runHeadless(options: RunHeadlessOptions): Promise<void> {
  const {
    feature,
    projectDir,
    opts,
    savedState,
    sessionId,
    _planner,
    _implementer,
    plannerContext,
    trustedCliGates,
  } = options;
  installTerminalOutputErrorGuard();
  const config = resolveRunConfig({ projectDir, opts, defaultApprove: 'none' });
  const runConfig = configForSessionTranscriptPolicy(
    config,
    sessionId === undefined ? undefined : { projectDir, sessionId },
  );

  if ((runConfig.workflow.taskReview ?? 'none') !== 'none') {
    throw cliError(
      'workflow.taskReview requires an interactive TUI run. Set workflow.taskReview: none for headless mode.',
    );
  }

  const abortController = new AbortController();
  const onSignal = () => abortController.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    await runWorkflow({
      feature,
      plannerContext,
      projectDir,
      config: runConfig,
      headless: true,
      allowHooks: opts.allowHooks ?? false,
      allowRepoRunners: opts.allowRepoRunners ?? false,
      sinks: buildNoopSinks(),
      modelCache: modelCacheStore,
      drainPendingAttachments: () => attachmentsStore.drain(),
      savedState,
      sessionId,
      signal: abortController.signal,
      _planner,
      _implementer,
      trustedCliGates,
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
}
