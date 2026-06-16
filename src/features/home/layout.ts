import { getResponsivePanelWidth } from '../../utils/terminal-width.js';
import { getLogoTier, getLogoHeight, type LogoTier } from './logo.js';

interface HomeLayoutInput {
  cols: number;
  rows: number;
  isSmall: boolean;
  hasSkills: boolean;
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
  hasSkills: boolean;
  sessionCount: number;
}

export const CONFIG_SUMMARY_COMPACT_ROWS = 30;

export function getConfigSummaryHeight(isSmall: boolean, rows: number, hasSkills: boolean): number {
  const compact = isSmall || rows < CONFIG_SUMMARY_COMPACT_ROWS;
  if (compact) return 1;
  return 3 + (hasSkills ? 1 : 0);
}

function getContentAwareSessionLimit(input: SessionLimitInput): {
  recentSessionLimit: number;
  showHiddenCount: boolean;
} {
  const { rows, isSmall, logoTier, inputBottomMargin, hasSkills, sessionCount } = input;
  const inputDock = 1 + 3 + inputBottomMargin;
  const bodyGaps = isSmall ? 0 : 2;
  const logoBlock = getLogoHeight(logoTier) + 1;
  const configBlock = getConfigSummaryHeight(isSmall, rows, hasSkills) + 1;
  const sessionsChrome = 1 + (isSmall ? 0 : 1) + 1;
  const available = rows - (inputDock + bodyGaps + logoBlock + configBlock + sessionsChrome);
  const capacity = Math.max(0, available);
  if (sessionCount <= capacity) {
    return { recentSessionLimit: capacity, showHiddenCount: false };
  }
  if (capacity <= 1) {
    return { recentSessionLimit: capacity, showHiddenCount: false };
  }
  return { recentSessionLimit: Math.max(0, capacity - 1), showHiddenCount: true };
}

const FOCUSED_SESSIONS_EXTRA_CHROME = 4;

export function getHomeLayout({
  cols,
  rows,
  isSmall,
  hasSkills,
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
    hasSkills,
    sessionCount,
  });
  const focusedRecentSessionLimit = sessionsFocused
    ? Math.max(recentSessionLimit > 0 ? 1 : 0, recentSessionLimit - FOCUSED_SESSIONS_EXTRA_CHROME)
    : recentSessionLimit;

  return {
    inputWidth,
    bodyWidth,
    logoTier,
    inputBottomMargin,
    recentSessionLimit: focusedRecentSessionLimit,
    showHiddenCount,
  };
}
