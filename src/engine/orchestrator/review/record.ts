import { readEvidenceLedger, writeEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { REVIEW_JSON_FILE, REVIEW_FILE } from '../../../core/paths.js';
import { type ReviewScope, findingInReviewScope } from '../../../core/review/scope.js';
import {
  type ReviewOutcome,
  setAsideInputs,
  blockingEntries,
  blockingKeys,
} from '../../../core/review/verdict.js';
import type { EvidenceFinalReviewStatus } from '../../../core/schemas/evidence.js';
import type {
  ReviewVerdict,
  SetAside,
  TriageResult,
} from '../../../core/schemas/review/verdict.js';
import type { ReviewRecord } from '../../../core/schemas/workflow/review-record.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { fixCyclesOf } from '../../../core/state/selectors.js';
import { type SpecMetadata, writeSpecFile } from '../../../core/sessions/spec-files.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { warnError } from '../../../lib/warn.js';
import { nowIso } from '../../../utils/format/time.js';
import type { EngineEventOf, EventBus } from '../../events/types.js';
import { NULL_CACHE } from '../../providers/model/runtime-snapshot.js';
import { persistReviewEvidence } from '../evidence/decisions.js';
import { recordFinalReviewEvidence } from '../evidence/reporting.js';
import { writeReviewPacket } from '../evidence/review-packet/build.js';
import type { RunReviewScope } from '../evidence/review-packet/run-scope.js';
import type { BuildReviewPacketOptions } from '../evidence/review-packet/types.js';
import { publishWarningFromError } from '../publish/notice.js';
import { publishReviewEvent } from '../publish/review.js';
import { transitionAndSave } from '../state-ops/transition.js';
import { type SummaryBase, buildSummary } from '../summary/build.js';
import type { FinalReview, ReviewStatePort } from './types.js';

/** A failed ledger write warns and never stops the run: the review outcome is in the state. */
export function recordFinalReviewStatus(ref: SessionRef, status: EvidenceFinalReviewStatus): void {
  try {
    const ledger = readEvidenceLedger(ref);
    if (ledger) writeEvidenceLedger(ref, recordFinalReviewEvidence({ ledger, status }));
  } catch (err) {
    warnError('Failed to record final review evidence', err);
  }
}

/**
 * Records the review on the state: the review record, its evidence, and the triage of its fix
 * work when it has any. Each saved state goes to `live` at once, so a later failure keeps it.
 */
export function recordReview(input: {
  projectDir: string;
  sessionId: string;
  bus: EventBus;
  live: ReviewStatePort;
  cadence: 'final' | 'task';
  scope: ReviewScope;
  verdict: ReviewVerdict;
  outcome: ReviewOutcome;
  verification: ReviewRecord['verification'];
  fixWork: TriageResult;
  preExistingChecks: NonNullable<ReviewRecord['preExistingChecks']>;
  unseenRenderCriteria: readonly string[];
}): { record: ReviewRecord; setAside: SetAside[] } {
  const { projectDir, sessionId, live, scope, outcome, fixWork, preExistingChecks } = input;
  const setAside = setAsideInputs(live.get().pendingTriage?.inputs ?? [], fixWork);
  const record: ReviewRecord = {
    scope: input.cadence,
    cycle: fixCyclesOf(live.get()).used,
    verdict: input.verdict,
    outcome: outcome.kind,
    verification: input.verification,
    ...(outcome.redInputs.length > 0 && { redInputs: outcome.redInputs }),
    ...(preExistingChecks.length > 0 && { preExistingChecks }),
    ...(input.unseenRenderCriteria.length > 0 && {
      unseenRenderCriteria: [...input.unseenRenderCriteria],
    }),
    at: nowIso(),
  };
  live.set(
    transitionAndSave({ projectDir, sessionId }, live.get(), {
      type: 'RECORD_REVIEW',
      review: record,
    }),
  );
  const state = live.get();
  persistReviewEvidence({
    wctx: { projectDir, sessionId, bus: input.bus },
    state,
    review: {
      scope: scope.kind,
      ...(state.review?.afterTaskId !== undefined && { afterTaskId: state.review.afterTaskId }),
      cycle: fixCyclesOf(state).briefed,
      outcome: record.outcome,
      blocking: blockingEntries(outcome),
      ...(setAside.length > 0 && { setAside }),
      at: record.at,
    },
  });
  if (fixWork.fixTasks.length > 0 || fixWork.rejected.length > 0 || fixWork.ask !== null)
    live.set(
      transitionAndSave({ projectDir, sessionId }, state, {
        type: 'RECORD_TRIAGE',
        record: {
          cycle: fixCyclesOf(state).used + 1,
          at: nowIso(),
          reviewAt: record.at,
          inputIds: [
            ...input.verdict.findings
              .filter(
                (finding) =>
                  finding.severity === 'blocking' &&
                  finding.kind !== 'unverified' &&
                  findingInReviewScope(finding, scope),
              )
              .map((finding) => finding.id),
            ...(state.pendingTriage?.inputs ?? []).map((triageInput) => triageInput.id),
          ],
          result: fixWork,
          blocking: blockingKeys(outcome, state.pendingTriage?.inputs ?? []),
          scope: scope.kind,
        },
      }),
    );
  return { record, setAside };
}

/** The review's own files: the record as `review.json` and the verdict text as `review.md`. */
export function writeReviewFiles(
  ref: SessionRef,
  record: ReviewRecord,
  reviewText: string,
  metadata: SpecMetadata | null | undefined,
): void {
  writeSpecFile(ref, REVIEW_JSON_FILE, `${JSON.stringify(record)}\n`, metadata);
  writeSpecFile(ref, REVIEW_FILE, reviewText, metadata);
}

/**
 * The end of a review that was not stopped: its status in the ledger, the completion event, and
 * for a final review the packet. A failed packet write warns and never stops the run.
 */
export async function finishReview(input: {
  projectDir: string;
  workspaceDir: string;
  sessionId: string;
  bus: EventBus;
  state: WorkflowState;
  event: Pick<EngineEventOf<'review_started'>, 'scope' | 'afterTaskId' | 'tool' | 'model' | 'axes'>;
  startedAt: number;
  writeStatus: 'written' | 'failed';
  verdict: FinalReview | null;
  setAside: SetAside[];
  /** The base of the packet's summary; a review with none, or a task-cadence review, writes no packet. */
  summaryBase: SummaryBase | undefined;
  reviewScope: RunReviewScope | undefined;
  reviewInput: BuildReviewPacketOptions['reviewInput'];
}): Promise<void> {
  const { projectDir, workspaceDir, sessionId, bus, state, verdict, setAside } = input;
  recordFinalReviewStatus({ projectDir, sessionId }, input.writeStatus);

  const blockingFindings = verdict === null ? [] : blockingEntries(verdict.outcome);
  publishReviewEvent(
    { bus, phase: state.phase },
    {
      type: 'review_completed',
      ...input.event,
      verdict: verdict?.outcome.kind ?? 'no-verdict',
      ...(verdict !== null && {
        findings: {
          blocking: blockingFindings.length,
          minor: verdict.outcome.minor.length,
          outOfScope: verdict.outcome.outOfScope.length,
          ...(verdict.outcome.unverifiedCriteria.length > 0 && {
            unverifiedCriteria: verdict.outcome.unverifiedCriteria.length,
          }),
        },
      }),
      ...(blockingFindings.length > 0 && { blockingFindings }),
      ...(verdict !== null && setAside.length > 0 && { setAside }),
      duration: Date.now() - input.startedAt,
    },
  );

  // The packet is the final review's artifact; a task-cadence review writes only
  // review.json and review.md.
  const { summaryBase, reviewScope, reviewInput } = input;
  if (input.event.scope === 'task' || summaryBase === undefined) return;
  try {
    await writeReviewPacket({
      projectDir,
      workspaceDir,
      sessionId,
      summary: buildSummary({
        ...summaryBase,
        projectDir,
        sessionId,
        state,
      }),
      state,
      finalReviewStatus: input.writeStatus,
      modelCache: summaryBase.pricingCache ?? NULL_CACHE,
      ...(reviewScope !== undefined && { provenance: reviewScope.provenance }),
      ...(reviewInput !== undefined && { reviewInput }),
    });
  } catch (err) {
    publishWarningFromError({ bus, phase: state.phase }, 'Review packet generation failed', err);
  }
}
