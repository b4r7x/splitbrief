import { CREW_SEAT_LABELS } from '../../core/crew/identity.js';
import { getTerminalCellWidth, sanitizeTerminalDisplayText } from '../../utils/display-text.js';
import { SOFT_SEP } from '../../core/separators.js';
import { formatAttachmentFailure } from '../../core/attachments/failure.js';
import type { DraftSubmission } from '../../core/composer/submission.js';
import { formatSeatIdentity } from '../../core/crew/identity.js';
import { resolveSeatDisplayName } from '../../engine/providers/model/display-names.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { configStore } from '../../stores/project/config.js';
import {
  fitFeedbackMessage,
  matchKnownFeedbackMessage,
  type FeedbackMessageInput,
} from './feedback-fit.js';

const RESUME_INTERRUPTED_PREFIX = 'Cannot resume "';
const RESUME_INTERRUPTED_SUFFIX = '": interrupted before it made progress — start it again.';
const SESSION_FAILED_PREFIX = 'Session "';
const SESSION_FAILED_SUFFIX = '" failed without a summary to display';
const NO_VISION_PREFIX = `Cannot attach: ${CREW_SEAT_LABELS.plan} seat `;
const NO_VISION_SUFFIX = ' cannot see images — /crew plan';
const DROP_AFFORDANCE = `${SOFT_SEP}drop an image`;
const FEEDBACK_MAX_ROWS = 4;

export function noVisionFeedbackMessage(seatIdentity: string): string {
  return `${NO_VISION_PREFIX}${seatIdentity}${NO_VISION_SUFFIX}`;
}

export function formatSubmissionFailure(
  submission: Extract<DraftSubmission, { ok: false }>,
): string {
  if (submission.reason === 'command') {
    return 'A slash command is not a message. Run it from the composer.';
  }
  const config = configStore.get().config;
  return submission.reason === 'no-vision'
    ? config === null
      ? 'Cannot send image: the planner cannot see images. Choose a vision model with /crew plan.'
      : noVisionFeedbackMessage(
          formatSeatIdentity({
            seat: config.planner,
            displayName: resolveSeatDisplayName(config.planner, 'planner', modelCacheStore),
          }),
        )
    : formatAttachmentFailure({
        action: 'send',
        reason: submission.reason,
        path: submission.path,
      });
}

function structureKnownFeedbackMessage(message: string): FeedbackMessageInput {
  return (
    matchKnownFeedbackMessage(message, RESUME_INTERRUPTED_PREFIX, RESUME_INTERRUPTED_SUFFIX) ??
    matchKnownFeedbackMessage(message, SESSION_FAILED_PREFIX, SESSION_FAILED_SUFFIX) ??
    matchKnownFeedbackMessage(message, NO_VISION_PREFIX, NO_VISION_SUFFIX) ??
    message
  );
}

export interface HomeHintLines {
  feedbackLine: string | null;
  homeHintLine: string | null;
}

// Feedback takes the home row from the hint when there is any. A notice keeps the row: the
// feedback stacks above it, so the notice row stays put while feedback comes and goes. Feedback
// wraps at word boundaries onto up to FEEDBACK_MAX_ROWS rows, so a long save message keeps its
// sign-in command; the hint is one row. A focused chat input paints no placeholder (segments.ts),
// so the drop affordance rides the hint line — the one home row that renders while the box is
// live enough to take a drop. It is the optional half of that line: it goes whole, or not at all,
// never clipped, and never under feedback.
export function deriveHomeHintLines(opts: {
  active: boolean;
  homeHint: string | undefined;
  notice?: string | undefined;
  feedbackMessage: string | null;
  width: number;
  dropEnabled: boolean;
}): HomeHintLines {
  const { active, homeHint, notice, feedbackMessage, dropEnabled } = opts;
  const width = Math.max(1, opts.width);
  if (!active || homeHint === undefined) return { feedbackLine: null, homeHintLine: null };

  if (feedbackMessage !== null) {
    return {
      feedbackLine: fitFeedbackMessage(
        structureKnownFeedbackMessage(sanitizeTerminalDisplayText(feedbackMessage)),
        { width, maxRows: FEEDBACK_MAX_ROWS },
      ),
      homeHintLine: notice ?? null,
    };
  }

  const line = notice ?? homeHint;
  const dropFits = getTerminalCellWidth(`${line}${DROP_AFFORDANCE}`) <= width;
  return {
    feedbackLine: null,
    homeHintLine: `${line}${dropEnabled && dropFits ? DROP_AFFORDANCE : ''}`,
  };
}
