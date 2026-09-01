import { CREW_SEAT_LABELS } from '../../core/crew/identity.js';
import { getTerminalCellWidth, sanitizeTerminalDisplayText } from '../../utils/display-text.js';
import { SOFT_SEP } from '../separators.js';
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

export function noVisionFeedbackMessage(seatIdentity: string): string {
  return `${NO_VISION_PREFIX}${seatIdentity}${NO_VISION_SUFFIX}`;
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

// The home row is one line: feedback takes it when there is any, otherwise the hint does.
// A focused chat input paints no placeholder (segments.ts), so the drop affordance rides
// the hint line — the one home row that renders while the box is live enough to take a drop.
// It is the optional half of that line: it goes whole, or not at all, never clipped.
export function deriveHomeHintLines(opts: {
  active: boolean;
  homeHint: string | undefined;
  feedbackMessage: string | null;
  width: number;
  dropEnabled: boolean;
}): HomeHintLines {
  const { active, homeHint, feedbackMessage, dropEnabled } = opts;
  const width = Math.max(1, opts.width);
  if (!active || homeHint === undefined) return { feedbackLine: null, homeHintLine: null };

  if (feedbackMessage !== null) {
    return {
      feedbackLine: fitFeedbackMessage(
        structureKnownFeedbackMessage(sanitizeTerminalDisplayText(feedbackMessage)),
        width,
      ),
      homeHintLine: null,
    };
  }

  const dropFits = getTerminalCellWidth(`${homeHint}${DROP_AFFORDANCE}`) <= width;
  return {
    feedbackLine: null,
    homeHintLine: `${homeHint}${dropEnabled && dropFits ? DROP_AFFORDANCE : ''}`,
  };
}
