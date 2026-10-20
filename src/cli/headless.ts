import type { Planner } from '../engine/planners/types.js';
import type { Implementer } from '../engine/implementers/types.js';
import type { PreparedExecution } from '../engine/runners/prepared-execution.js';
import type { prepareExecution } from '../engine/runners/prepare-execution/prepare-execution.js';
import type { PreparationPolicy } from '../engine/runners/prepare-execution/types.js';
import { loadOwnerWorkflowState } from '../core/state/resume-hydration.js';
import type { SessionRef } from '../core/types/session-ref.js';
import type { SeatDownPolicy } from '../core/types/config-options.js';
import type { Config } from '../core/schemas/config.js';
import type { WorkflowState } from '../core/schemas/workflow.js';
import { recoveryFactString } from '../core/schemas/recovery/facts.js';
import { readSession } from '../core/sessions/io.js';
import { runWorkflow } from '../engine/orchestrator/run/workflow.js';
import { applyOfferedSeatSwap } from '../engine/orchestrator/run/seat-swap.js';
import { createRecoveryBus } from '../engine/orchestrator/recovery/bus.js';
import { publishRetainedWorkspaceNotice } from '../engine/orchestrator/isolation/retention.js';
import { discoverSkills } from '../engine/skill-discovery.js';
import type { SkillMeta } from '../core/skills/types.js';
import {
  GLOBAL_SKILL_SCAN_PATH_LABELS,
  PROJECT_SKILL_SCAN_PATH_LABELS,
} from '../core/skills/scan-paths.js';
import { modelCacheStore } from '../stores/discovery/model-cache/state.js';
import { attachmentsStore } from '../stores/workflow/attachments.js';
import { deriveRunStatus, isAnsweredApplyRecovery } from '../core/sessions/run-status.js';
import { continuesHeadless, formatResumeCommand } from '../core/recovery/resume-command.js';
import { reviewFailedCause, reviewName } from '../core/recovery/headline.js';
import { haltOf, recoveryHaltLabel } from '../core/recovery/halt.js';
import { formatResetAt } from '../core/recovery/reset-clock.js';
import { cliError } from './errors.js';
import { applyCommand, discardCommand, readyToApplyMessage } from './sessions/resolve.js';
import { installTerminalOutputErrorGuard } from '../lib/terminal/control.js';
import { writeHeadlessJsonRecord } from '../engine/events/public-json.js';
import { boundEngineEventForConsumer } from '../engine/events/bound.js';

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
    const message =
      conversation.text.trim() ||
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
  if (!issue || isAnsweredApplyRecovery(issue)) return;
  const resumeCommand = formatResumeCommand(sessionId, issue);
  // A seat-down halt is self-contained for a machine consumer: the finer cause,
  // the tool's own words, the request id, the reset and the declared fallback.
  const cause = recoveryFactString(issue.facts, 'cause');
  const providerMessage = recoveryFactString(issue.facts, 'providerMessage');
  const requestId = recoveryFactString(issue.facts, 'requestId');
  const fallback = recoveryFactString(issue.facts, 'fallback');
  writeRecord(
    {
      type: 'recovery_required',
      sessionId,
      halt: haltOf(issue.reason),
      reason: issue.reason,
      status: issue.status,
      message: issue.message,
      taskId: issue.taskId,
      files: issue.files,
      affectedTaskIds: issue.affectedTaskIds,
      availableActions: issue.availableActions,
      recommendedAction: issue.recommendedAction,
      resumeCommand,
      ...(cause !== undefined && { cause }),
      ...(providerMessage !== undefined && { providerMessage }),
      ...(requestId !== undefined && { requestId }),
      ...(issue.resetAt !== undefined && { resetAt: issue.resetAt }),
      ...(fallback !== undefined && { fallback }),
    },
    process.stdout,
  );
  // The stored message names no clock; a quota halt's reset is spelled when the line is printed.
  const reset = formatResetAt(issue.resetAt);
  throw cliError(
    `${recoveryHaltLabel(haltOf(issue.reason))} (${issue.reason}): ${issue.message}${reset === undefined ? '' : ` (${reset})`}\nRecommended: ${issue.recommendedAction}\nContinue with: ${resumeCommand}${continuesHeadless(issue) ? ' [--plain|--json]' : ''}`,
    1,
  );
}

/**
 * A run with a reviewed result in its workspace is ready to apply, whether the review passed or the
 * operator accepted it as is: that is a finished headless run, not a failed review.
 */
function emitReadyToApply(
  state: WorkflowState | null,
  sessionId: string,
  writeRecord: RecordWriter,
): boolean {
  const status = state === null ? null : deriveRunStatus({ state, liveness: 'not-alive' });
  if (status?.kind !== 'ready-to-apply') return false;
  writeRecord(
    {
      type: 'ready_to_apply',
      sessionId,
      override: status.override,
      applyCommand: applyCommand(sessionId),
      discardCommand: discardCommand(sessionId),
    },
    process.stdout,
  );
  process.stderr.write(`${readyToApplyMessage(sessionId)}\n`);
  return true;
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
  throw cliError(
    `${reviewFailedCause(reviewName({ scope: 'final' }), blocking)}; see review.md`,
    1,
  );
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

/**
 * `cause` is the last error the run published under `--plain`, where no NDJSON
 * record carries it; it is printed here, once, so the pointer below is true.
 */
export function failIfSessionFailed(
  state: WorkflowState | null,
  sessionId: string,
  writeRecord: RecordWriter,
  cause: string | undefined,
): void {
  if (state === null) return;
  const status = deriveRunStatus({ state, liveness: 'not-alive' });
  if (status.kind !== 'open' || status.stop.on.kind !== 'failed') return;
  writeRecord({
    type: 'error',
    message: `Session ${sessionId} ended with status failed.`,
  });
  if (cause !== undefined) process.stderr.write(`${cause}\n`);
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
  /** `--on-seat-down`: how a seat-down halt is answered. Unset defers to the seat's fallback. */
  onSeatDown?: SeatDownPolicy | undefined;
  /** `--allow-unverified-auth`: admit a swapped-in seat on unverified auth as the first run did. */
  allowUnverifiedAuth?: boolean | undefined;
  _planner?: Planner | undefined;
  _implementer?: Implementer | undefined;
  /** Tests: the preparation the seat swap drives, so no real engine is needed. */
  _prepare?: typeof prepareExecution | undefined;
}

/** Whether any seat — the three live ones and every build profile — declares a fallback. */
function configDeclaresFallback(config: Config): boolean {
  const runners = [
    config.planner,
    config.implementer,
    ...(config.reviewer !== undefined ? [config.reviewer] : []),
    ...Object.values(config.implementerProfiles?.profiles ?? {}),
  ];
  return runners.some((runner) => runner.fallback !== undefined);
}

/**
 * The terms the swapped-in seat is admitted under: the run's own, as a headless
 * resume. The seat swap is the run loop's re-entry, so it prepares the way the
 * first headless admission did — hooks and repo runners as the run had them,
 * unverified auth only when the operator asked for it.
 */
function headlessResumePolicy(
  prepared: PreparedExecution,
  allowUnverifiedAuth: boolean,
): Extract<PreparationPolicy, { purpose: 'resume' }> {
  return {
    purpose: 'resume',
    interaction: 'headless',
    allowRepoRunners: prepared.runtime.allowRepoRunners,
    allowHooks: prepared.runtime.allowHooks,
    unverifiedAuth: allowUnverifiedAuth ? 'allowed' : 'denied',
    modelCache: modelCacheStore,
  };
}

export async function runHeadless(options: RunHeadlessOptions): Promise<void> {
  const { plain, selectedSkills, _planner, _implementer } = options;
  const projectDir = options.prepared.session.ref.projectDir;
  const sessionId = options.prepared.session.ref.sessionId;
  installTerminalOutputErrorGuard();
  const writeRecord = recordWriterFor(plain === true);
  let lastError: string | undefined;
  const publishHandoffNotice = async (state: WorkflowState | null): Promise<void> => {
    if (state === null) return;
    await publishRetainedWorkspaceNotice({
      projectDir,
      sessionId,
      state,
      bus: createRecoveryBus({
        projectDir,
        sessionId,
        sink: (event) => {
          const bounded = boundEngineEventForConsumer(event, 'stdout-text');
          if (plain === true && (bounded.type === 'warning' || bounded.type === 'error'))
            process.stderr.write(`${bounded.message}\n`);
          else writeRecord({ type: 'event', data: event });
        },
      }),
    });
  };

  // The handlers are installed before the pending-halt preflight: the preflight
  // reads state and may stop, and an operator's interrupt must still land while
  // it does.
  const abortController = new AbortController();
  const onSignal = () => abortController.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    // An explicit `switch` with nothing to switch to is a usage error, named for
    // the word the operator would have to add to the config.
    if (options.onSeatDown === 'switch' && !configDeclaresFallback(options.prepared.config)) {
      throw cliError(
        '`--on-seat-down switch` needs a seat that declares `fallback`; this config declares none.',
        2,
      );
    }

    const swapPolicy = headlessResumePolicy(options.prepared, options.allowUnverifiedAuth === true);
    let prepared = options.prepared;
    let savedState = prepared.runtime.resumeState;

    for (;;) {
      // The automatic intent a halt left is taken before the run that would hit the
      // same seat again: an admitted swap resolves the halt and prepares this
      // session on the new seat, so `runWorkflow`'s re-entry runs on it.
      const before = loadOwnedState({ projectDir, sessionId });
      const auto = before?.pendingRecovery?.switchSeat?.auto;
      if (before !== null && auto !== undefined && options.onSeatDown !== 'halt') {
        const swapped = await applyOfferedSeatSwap({
          choice: { candidate: auto.candidate, policy: swapPolicy },
          projectDir,
          sessionId,
          bus: createRecoveryBus({
            projectDir,
            sessionId,
            sink: (event) => writeRecord({ type: 'event', data: event }),
          }),
          config: prepared.config,
          prepared,
          savedState: before,
          signal: abortController.signal,
          ...(options._prepare !== undefined && { prepare: options._prepare }),
        });
        if (swapped !== undefined) {
          prepared = swapped.prepared;
          savedState = swapped.state;
        }
        // A swap that did not resolve the halt leaves the same intent pending; there
        // is no picker headlessly, so the halt is reported exactly as one no one
        // answered and the run stops.
        const after = loadOwnedState({ projectDir, sessionId });
        if (after !== null && after.pendingRecovery?.switchSeat?.auto !== undefined) {
          await publishHandoffNotice(after);
          emitRecoveryAndFailIfPending({ state: after, sessionId, writeRecord });
        }
      }

      // A resumed session with a pending recovery is already an owner-controlled
      // state machine. A headless observation must report it, not manufacture a
      // retry by entering the ordinary workflow loop (which would invoke a
      // planner/provider).
      if (prepared.purpose === 'resume') {
        const preflight = loadOwnedState({ projectDir, sessionId });
        if (preflight !== null) {
          if (
            preflight.pendingRecovery !== undefined &&
            !isAnsweredApplyRecovery(preflight.pendingRecovery)
          )
            await publishHandoffNotice(preflight);
          emitRecoveryAndFailIfPending({ state: preflight, sessionId, writeRecord });
        }
      }

      lastError = undefined;
      await runWorkflow({
        prepared,
        headless: true,
        sinks: buildNoopSinks(),
        modelCache: modelCacheStore,
        drainPendingAttachments: () => attachmentsStore.drain(),
        signal: abortController.signal,
        ...(plain === true && {
          plain: true,
          tuiSink: (event) => {
            if (event.type !== 'error') return;
            const bounded = boundEngineEventForConsumer(event, 'stdout-text');
            if (bounded.type === 'error') lastError = bounded.message;
          },
        }),
        selectedSkills,
        _planner,
        _implementer,
        savedState,
        callbacks: {
          onApprovalNeeded: async (_type, _input) => ({ approved: true, unattended: true }),
          onComplete: () => undefined,
        },
      });

      if (abortController.signal.aborted) {
        await publishHandoffNotice(loadOwnedState({ projectDir, sessionId }));
        return;
      }

      // Another seat went down with its own intent: take it and re-enter. The loop
      // ends when no automatic intent is pending.
      if (options.onSeatDown === 'halt') break;
      const next = loadOwnedState({ projectDir, sessionId });
      if (next?.pendingRecovery?.switchSeat?.auto === undefined) break;
    }
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }

  if (abortController.signal.aborted) return;

  const finalState = loadOwnedState({ projectDir, sessionId });
  await publishHandoffNotice(finalState);
  emitRecoveryAndFailIfPending({ state: finalState, sessionId, writeRecord });
  if (emitReadyToApply(finalState, sessionId, writeRecord)) return;
  const status =
    finalState === null ? null : deriveRunStatus({ state: finalState, liveness: 'not-alive' });
  if (status?.kind === 'closed' && status.as === 'complete') return;
  failIfFinalReviewFailed(finalState, projectDir, sessionId, writeRecord);
  failIfFinalReviewIncomplete(finalState, sessionId, writeRecord);
  failIfSessionFailed(finalState, sessionId, writeRecord, lastError);
  failIfSessionInterrupted(projectDir, sessionId, writeRecord);
}
