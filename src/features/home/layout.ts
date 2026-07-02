import { getResponsivePanelWidth } from '../../utils/terminal-width.js';
import { getLogoTier, getLogoHeight, type LogoTier } from './logo.js';

interface HomeLayoutInput {
  cols: number;
  rows: number;
  isSmall: boolean;
  sessionCount?: number;
  sessionsFocused?: boolean | undefined;
}

interface HomeLayout {
  inputWidth: number;
  bodyWidth: number;
  logoTier: LogoTier;
  inputBottomMargin: number;
  recentSessionLimit: number;
  showHiddenCount: boolean;
}

interface SessionLimitInput {
  rows: number;
  isSmall: boolean;
  logoTier: LogoTier;
  inputBottomMargin: number;
  sessionCount: number;
  sessionsFocused: boolean;
}

const FOCUSED_FILTER_BLOCK_ROWS = 4;
const FOCUSED_SELECTION_ERROR_ROWS = 1;

function getContentAwareSessionLimit(input: SessionLimitInput): {
  recentSessionLimit: number;
  showHiddenCount: boolean;
} {
  const { rows, isSmall, logoTier, inputBottomMargin, sessionCount, sessionsFocused } = input;
  const inputDock = 1 + 3 + inputBottomMargin;
  const bodyGaps = isSmall ? 0 : 2;
  const logoBlock = getLogoHeight(logoTier) + 1;
  const configBlock = 1 + 1;
  const sessionsChrome = 1 + (isSmall ? 0 : 1) + 1;
  const baseAvailable = rows - (inputDock + bodyGaps + logoBlock + configBlock + sessionsChrome);
  const baseCapacity = Math.max(0, baseAvailable);
  if (sessionsFocused) {
    const capacity = Math.max(
      0,
      baseCapacity - FOCUSED_FILTER_BLOCK_ROWS - FOCUSED_SELECTION_ERROR_ROWS,
    );
    return { recentSessionLimit: capacity, showHiddenCount: false };
  }
  if (sessionCount <= baseCapacity) {
    return { recentSessionLimit: baseCapacity, showHiddenCount: false };
  }
  if (baseCapacity <= 1) {
    return { recentSessionLimit: baseCapacity, showHiddenCount: false };
  }
  return { recentSessionLimit: Math.max(0, baseCapacity - 1), showHiddenCount: true };
}

export function getHomeLayout({
  cols,
  rows,
  isSmall,
  sessionCount = 0,
  sessionsFocused = false,
}: HomeLayoutInput): HomeLayout {
  const inputWidth = getResponsivePanelWidth({
    cols,
    size: isSmall ? 'small' : 'large',
    widths: { small: 70, large: 92 },
    gutter: 8,
  });
  const bodyWidth = isSmall ? inputWidth : Math.min(inputWidth, 72);
  const logoTier = getLogoTier(rows, cols);
  const inputBottomMargin = rows >= 38 ? 2 : rows >= 30 ? 1 : 0;
  const { recentSessionLimit, showHiddenCount } = getContentAwareSessionLimit({
    rows,
    isSmall,
    logoTier,
    inputBottomMargin,
    sessionCount,
    sessionsFocused,
  });

  return {
    inputWidth,
    bodyWidth,
    logoTier,
    inputBottomMargin,
    recentSessionLimit,
    showHiddenCount,
  };
}
