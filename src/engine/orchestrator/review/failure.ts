import { requireReviewSeat } from '../../../core/config/accessors/reviewer-runner.js';
import { getRunnerCatalogDisplayName } from '../../../core/config/accessors/runner-config.js';
import { reviewChangeFile } from '../../../core/paths.js';
import { reviewName } from '../../../core/recovery/causes.js';
import type { Config } from '../../../core/schemas/config.js';
import type { Phase } from '../../../core/schemas/enums.js';
import { labelError } from '../../../utils/format/errors.js';
import { isRecord } from '../../../utils/type-guards.js';
import type { EventBus } from '../../events/types.js';
import {
  typedRunnerCallErrorCode,
  typedRunnerCallErrorMessage,
} from '../../implementers/pipeline/call-result.js';
import { readApiContextDiagnostic } from '../../providers/api/context-diagnostic.js';
import { promptLength, inputTooLargeFigures } from '../../runners/input-limit.js';
import { publishError } from '../publish/notice.js';
import { reviewInputTooLargeMessage } from '../recovery/builders/review-input.js';
import { diagnosePlannerCallFailure } from '../recovery/planner-call-failure.js';
import { type FinalReviewFailure, REVIEW_UNAVAILABLE, type SentReviewPrompt } from './types.js';

function errorKind(err: unknown): string | undefined {
  return isRecord(err) && typeof err.kind === 'string' ? err.kind : undefined;
}

/**
 * Why a review that threw reached no verdict, published as the run's error unless the seat is
 * blocked. A failure the prompt or the call named before it threw keeps its kind; a seat that
 * refused the prompt as too large is measured against the prompt it was sent.
 */
export function publishReviewFailure(input: {
  err: unknown;
  named: FinalReviewFailure | undefined;
  sent: Pick<SentReviewPrompt, 'text' | 'suffix'>;
  config: Config;
  review: Readonly<{ scope?: string | undefined; afterTaskId?: string | undefined }>;
  sessionId: string;
  workspaceDir: string;
  bus: EventBus;
  phase: Phase;
}): FinalReviewFailure {
  const { err } = input;
  const seat = requireReviewSeat(input.config);
  const failed = `${reviewName(input.review)} failed`;
  const label =
    seat.source === 'configured'
      ? `${failed} (reviewer: ${getRunnerCatalogDisplayName(seat.runner)})`
      : failed;
  // The diagnosis is read off the error's own data, never off its wording, so
  // recovery keeps every missing section this review was refused for.
  const diagnostic = readApiContextDiagnostic(err);
  let failure = input.named;
  let message: string;
  let resetAt: string | undefined;
  const callErrorCode = typedRunnerCallErrorCode(err);
  if (callErrorCode === 'input-too-large') {
    const sent = promptLength(input.sent.text + input.sent.suffix);
    const figures = inputTooLargeFigures(typedRunnerCallErrorMessage(err) ?? '');
    failure = {
      kind: 'input-too-large',
      figures: { ...figures, size: figures.size ?? sent[figures.unit] },
      promptSize: sent,
      changeFile: reviewChangeFile(input.sessionId),
      workspaceDir: input.workspaceDir,
    };
  }
  if (failure?.kind === 'input-too-large') {
    message = reviewInputTooLargeMessage(failure, getRunnerCatalogDisplayName(seat.runner));
  } else if (failure?.kind === 'seat-protocol-error') {
    message = failure.error.message;
  } else if (diagnostic !== null) {
    message = labelError(label, err);
    failure = { kind: 'insufficient-context', diagnostic };
  } else {
    const diagnosis = diagnosePlannerCallFailure({
      err,
      label,
      runner: seat.runner,
      seat: 'review',
    });
    message = diagnosis.message;
    resetAt = diagnosis.resetsAt?.toISOString();
    failure =
      diagnosis.failure === 'call-failed' && diagnosis.cause !== 'implementer-recipe-invalid'
        ? {
            kind: 'call-failed',
            code: errorKind(err) ?? REVIEW_UNAVAILABLE,
            message,
            ...(diagnosis.cause !== undefined && { details: diagnosis.details }),
            ...(diagnosis.cause === 'non-zero-exit' && { cause: diagnosis.cause }),
          }
        : { kind: 'seat-blocked', diagnosis };
  }
  if (failure.kind !== 'seat-blocked')
    publishError({
      bus: input.bus,
      phase: input.phase,
      message,
      resetAt,
      safety: {
        category: 'recovery',
        code: failure.kind === 'input-too-large' ? 'review_input_too_large' : 'review_failed',
      },
    });
  return failure;
}
