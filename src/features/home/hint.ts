import type { NoticeMessage } from '../../components/notice.js';
import {
  BOOT_MANIFEST_TITLE,
  REFRESHING_TOOLS_TITLE,
  TOOL_CHECK_FAILED_TITLE,
  TOOLS_NOT_CHECKED_TITLE,
} from '../../core/discovery/copy.js';
import { SOFT_SEP } from '../../core/separators.js';
import { RECENT_SESSIONS_HINT } from './recent-sessions/list.js';
import type { HomeToolCheck } from './tool-check.js';

const DEFAULT_HOME_HINT = `/help${SOFT_SEP}/crew${SOFT_SEP}/settings${SOFT_SEP}/skills${SOFT_SEP}ctrl+k commands`;
const HOME_HINT = `/help${SOFT_SEP}/crew${SOFT_SEP}/settings${SOFT_SEP}/skills${SOFT_SEP}ctrl+r recent${SOFT_SEP}ctrl+k commands`;

interface HomeComposerHintInput {
  interactionBlocked: boolean;
  canFocus: boolean;
  sessionsActive: boolean;
  /** The tool check shows on the hint line, not in its box. */
  hintNotice: boolean;
  toolCheck: HomeToolCheck;
  refreshFrame: string;
}

interface HomeComposerHint {
  homeHint: string | undefined;
  /** The running check, in the hint line's dim words. */
  homeNotice: string | undefined;
  /** A first check that settled without a result stands in the notice slot until it changes. */
  standingNotice: NoticeMessage | undefined;
}

const RETRY = `${SOFT_SEP}open /settings to retry`;

export function deriveHomeComposerHint({
  interactionBlocked,
  canFocus,
  sessionsActive,
  hintNotice,
  toolCheck,
  refreshFrame,
}: HomeComposerHintInput): HomeComposerHint {
  if (interactionBlocked) {
    return { homeHint: undefined, homeNotice: undefined, standingNotice: undefined };
  }
  const standingNotice: NoticeMessage | undefined =
    toolCheck === 'failed'
      ? { message: `${TOOL_CHECK_FAILED_TITLE}${RETRY}`, severity: 'error' }
      : toolCheck === 'not-run'
        ? { message: `${TOOLS_NOT_CHECKED_TITLE}${RETRY}`, severity: 'warning' }
        : undefined;
  if (sessionsActive) {
    return { homeHint: RECENT_SESSIONS_HINT, homeNotice: undefined, standingNotice };
  }
  const homeHint = canFocus ? HOME_HINT : DEFAULT_HOME_HINT;
  const running =
    toolCheck === 'cold'
      ? BOOT_MANIFEST_TITLE
      : toolCheck === 'warm'
        ? REFRESHING_TOOLS_TITLE
        : undefined;
  // A running check borrows the reserved hint line instead of adding a row.
  const homeNotice = hintNotice && running !== undefined ? `${refreshFrame} ${running}` : undefined;
  return { homeHint, homeNotice, standingNotice };
}
