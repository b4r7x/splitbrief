import type { ReviewOutcome } from '../../../core/review/verdict.js';
import type { Attachment } from '../../../core/schemas/attachment.js';
import type { Config } from '../../../core/schemas/config.js';
import type { ReviewVerdict, TriageResult } from '../../../core/schemas/review/verdict.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { error } from '../../../utils/error.js';
import type { EventBus } from '../../events/types.js';
import type { ApiContextDiagnostic } from '../../providers/api/context-diagnostic.js';
import type { PromptSize, PromptLength } from '../../runners/input-limit.js';
import type { SeatProtocolError } from '../../runners/typed-output.js';
import type { BuildReviewPacketOptions } from '../evidence/review-packet/types.js';
import type { PlannerCallDiagnosis } from '../recovery/planner-call-failure.js';
import type { SummaryBase } from '../summary/build.js';
import type { ValidationCommandRunner } from '../validation/types.js';

/** The code a failed review carries when the failure names none of its own. */
export const REVIEW_UNAVAILABLE = 'review-unavailable';

/**
 * Why a review reached no verdict. `insufficient-context` is the packet refusing
 * before anything was dispatched; `call-failed` is a transport or protocol
 * failure, summarized — never a fabricated blocker count; `seat-blocked` is a
 * seat that cannot run at all until its quota comes back, its login does, or it
 * names a model its tool lists.
 */
export type FinalReviewFailure =
  | Readonly<{ kind: 'insufficient-context'; diagnostic: ApiContextDiagnostic }>
  | Readonly<{
      kind: 'call-failed';
      code: string;
      message: string;
      details?: string[];
      cause?: 'non-zero-exit';
    }>
  | Readonly<{ kind: 'seat-blocked'; diagnosis: PlannerCallDiagnosis }>
  | Readonly<{
      kind: 'input-too-large';
      /** The size and the limit in the unit the limit counts, as far as the refusal named them. */
      figures: PromptSize;
      /** The prompt the seat was sent, so a seat change offers only the tools that take it. */
      promptSize: PromptLength;
      /**
       * The file the seat reads the change from, relative to `workspaceDir`. Only a CLI seat has a
       * cap or refuses a prompt as too large, and every CLI seat reads the change from this file.
       */
      changeFile: string;
      workspaceDir: string;
    }>
  | Readonly<{ kind: 'seat-protocol-error'; error: SeatProtocolError }>;

/**
 * The state of the review phase for a step that runs while other steps save it: `get` reads it
 * when the step needs it, and `set` hands back each state the step saved.
 */
export type ReviewStatePort = Readonly<{
  get: () => WorkflowState;
  set: (state: WorkflowState) => void;
}>;

/**
 * An input built again for each attempt. The prompt is completed once the seat's binding is
 * known, with the text the call appends after it, such as the answer schema a seat without
 * native typed output reads.
 */
export type PreparedReviewerCallInput = Readonly<{
  prompt: (suffix: string) => string;
  images?: readonly Attachment[] | undefined;
}>;

/**
 * The prompt the review seat was last sent. The prompt step writes it on each build, and a failed
 * call and the review packet read it after the call.
 */
export type SentReviewPrompt = {
  text: string;
  /** The text the call appends after the prompt, such as the answer schema; it counts toward the tool's limit too. */
  suffix: string;
  reviewInput: BuildReviewPacketOptions['reviewInput'];
  /** The cap the built prompt went over, before the seat was asked. */
  tooLarge: Extract<FinalReviewFailure, { kind: 'input-too-large' }> | undefined;
};

/** How far the final review got: a written verdict, or a call that did not land. */
export type ReviewPhaseStatus = 'written' | 'failed' | 'unparseable';

export type FinalReview = {
  verdict: ReviewVerdict;
  outcome: ReviewOutcome;
};

export type FinalReviewResult = {
  state: WorkflowState;
  summaryBase?: SummaryBase | undefined;
  verdict: FinalReview | null;
  fixWork: TriageResult | null;
  reviewText: string;
  reviewStatus: ReviewPhaseStatus;
  /**
   * Why this review reached no verdict, when it reached none. Additive: a
   * caller that does not read it sees the status it always saw.
   */
  failure?: FinalReviewFailure;
  /**
   * The pre-review raised a halt before a reviewer call could run.
   */
  preReview?: 'stopped' | undefined;
};

export const finalReviewError = {
  missingRunBaseline: () =>
    error(
      'final-review-missing-run-baseline',
      'Session state carries no run-start baseline, so the run diff cannot be bounded. Start a new run.',
    ),
} as const;

export type TriageContext = Readonly<{
  projectDir: string;
  workspaceDir: string;
  sessionId: string;
  bus: EventBus;
  config: Config;
  signal?: AbortSignal | undefined;
  runCommand?: ValidationCommandRunner | undefined;
}>;
