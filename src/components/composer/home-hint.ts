import { CREW_SEAT_LABELS } from '../../core/crew/identity.js';
import { getTerminalCellWidth } from '../../utils/display-text/width.js';
import { sanitizeTerminalDisplayText } from '../../utils/display-text/sanitize.js';
import { SOFT_SEP } from '../../core/separators.js';
import { formatAttachmentFailure } from '../../core/attachments/failure.js';
import type { DraftSubmission } from '../../core/composer/submission.js';
import { formatSeatIdentity } from '../../core/crew/identity.js';
import { resolveSeatDisplayName } from '../../engine/providers/model/display-names.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { configStore } from '../../stores/project/config.js';
import { matchKnownFeedbackMessage, type FeedbackMessageInput } from './feedback-fit.js';
import { layoutNotice, type NoticeLayout, type NoticeMessage } from '../notice.js';

const RESUME_INTERRUPTED_PREFIX = 'Cannot resume "';
const RESUME_INTERRUPTED_SUFFIX = '": interrupted before it made progress — start it again.';
const SESSION_FAILED_PREFIX = 'Session "';
const SESSION_FAILED_SUFFIX = '" failed without a summary to display';
const NO_VISION_PREFIX = `Cannot attach: ${CREW_SEAT_LABELS.plan} seat `;
const NO_VISION_SUFFIX = ' cannot see images — /crew plan';
const DROP_AFFORDANCE = `${SOFT_SEP}drop an image`;
// The rows the Home notice may take, frame included: 3 text rows in a frame, or 5 on bars.
const HOME_NOTICE_ROWS = 5;

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

/** The notice Home shows above the box, fitted to the Home width. */
export function layoutHomeNotice(notice: NoticeMessage, width: number): NoticeLayout {
  return layoutNotice(
    structureKnownFeedbackMessage(sanitizeTerminalDisplayText(notice.message)),
    notice.severity,
    { maxWidth: Math.max(1, width), maxRows: HOME_NOTICE_ROWS },
  );
}

// The hint line under the notice slot. A check the user waits on — the start check's status, then
// the running tool check — keeps the line under a notice too, without the drop affordance; the
// hint gives the line to a notice. A focused chat input paints no placeholder
// (segments.ts), so the drop affordance rides the hint line — the one home row that renders while
// the box is live enough to take a drop. It is the optional half of that line: it goes whole, or
// not at all, never clipped.
export function deriveHomeHintLine(opts: {
  active: boolean;
  homeHint: string | undefined;
  status: string | undefined;
  notice: string | undefined;
  noticeShown: boolean;
  width: number;
  dropEnabled: boolean;
}): string | null {
  const { active, homeHint, status, notice, noticeShown, dropEnabled } = opts;
  if (!active || homeHint === undefined) return null;
  if (status !== undefined) return status;
  if (noticeShown) return notice ?? null;
  const line = notice ?? homeHint;
  const dropFits = getTerminalCellWidth(`${line}${DROP_AFFORDANCE}`) <= Math.max(1, opts.width);
  return `${line}${dropEnabled && dropFits ? DROP_AFFORDANCE : ''}`;
}
