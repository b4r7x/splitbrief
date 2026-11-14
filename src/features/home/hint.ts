import type { HomeNotice } from '../../components/composer/view.js';
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
  homeNotice: HomeNotice | undefined;
}

export function deriveHomeComposerHint({
  interactionBlocked,
  canFocus,
  sessionsActive,
  hintNotice,
  toolCheck,
  refreshFrame,
}: HomeComposerHintInput): HomeComposerHint {
  if (interactionBlocked) return { homeHint: undefined, homeNotice: undefined };
  if (sessionsActive) return { homeHint: RECENT_SESSIONS_HINT, homeNotice: undefined };
  const homeHint = canFocus ? HOME_HINT : DEFAULT_HOME_HINT;
  // The notice borrows the reserved hint line instead of adding a row; under feedback it keeps
  // that line and the feedback stacks above it.
  if (!hintNotice) return { homeHint, homeNotice: undefined };
  if (toolCheck === 'failed') {
    return {
      homeHint,
      homeNotice: {
        text: `${TOOL_CHECK_FAILED_TITLE}${SOFT_SEP}open /settings to retry`,
        tone: 'error',
      },
    };
  }
  if (toolCheck === 'not-run') {
    return {
      homeHint,
      homeNotice: {
        text: `${TOOLS_NOT_CHECKED_TITLE}${SOFT_SEP}open /settings to retry`,
        tone: 'warning',
      },
    };
  }
  return {
    homeHint,
    homeNotice: {
      text: `${refreshFrame} ${toolCheck === 'cold' ? BOOT_MANIFEST_TITLE : REFRESHING_TOOLS_TITLE}`,
      tone: 'textDim',
    },
  };
}
