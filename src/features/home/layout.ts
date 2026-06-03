import { getResponsivePanelWidth } from '../../utils/terminal-width.js';
import { getLogoTier, getLogoHeight, type LogoTier } from './logo.js';

interface HomeLayoutInput {
  cols: number;
  rows: number;
  isSmall: boolean;
  hasSkills: boolean;
}

interface HomeLayout {
  inputWidth: number;
  bodyWidth: number;
  logoTier: LogoTier;
  inputBottomMargin: number;
  recentSessionLimit: number;
}

interface SessionLimitInput {
  rows: number;
  isSmall: boolean;
  logoTier: LogoTier;
  inputBottomMargin: number;
  hasSkills: boolean;
}

const RECENT_LIST_MAX_DISPLAY = 20;
export const CONFIG_SUMMARY_COMPACT_ROWS = 30;

export function getConfigSummaryHeight(isSmall: boolean, rows: number, hasSkills: boolean): number {
  const compact = isSmall || rows < CONFIG_SUMMARY_COMPACT_ROWS;
  if (compact) return 1;
  return 3 + (hasSkills ? 1 : 0);
}

function getContentAwareSessionLimit(input: SessionLimitInput): number {
  const { rows, isSmall, logoTier, inputBottomMargin, hasSkills } = input;
  const inputDock = 1 + 3 + inputBottomMargin;
  const bodyGaps = isSmall ? 0 : 2;
  const logoBlock = getLogoHeight(logoTier) + 1;
  const configBlock = getConfigSummaryHeight(isSmall, rows, hasSkills) + 1;
  const sessionsChrome = 1 + (isSmall ? 0 : 1) + 1 + 1;
  const available = rows - (inputDock + bodyGaps + logoBlock + configBlock + sessionsChrome);
  return Math.max(0, Math.min(available, RECENT_LIST_MAX_DISPLAY));
}

export function getHomeLayout({ cols, rows, isSmall, hasSkills }: HomeLayoutInput): HomeLayout {
  const inputWidth = getResponsivePanelWidth({
    cols,
    size: isSmall ? 'small' : 'large',
    widths: { small: 70, large: 92 },
    gutter: 8,
  });
  const bodyWidth = isSmall ? inputWidth : Math.min(inputWidth, 72);
  const logoTier = getLogoTier(rows, cols);
  const inputBottomMargin = rows >= 38 ? 2 : rows >= 30 ? 1 : 0;
  const recentSessionLimit = getContentAwareSessionLimit({
    rows,
    isSmall,
    logoTier,
    inputBottomMargin,
    hasSkills,
  });

  return {
    inputWidth,
    bodyWidth,
    logoTier,
    inputBottomMargin,
    recentSessionLimit,
  };
}
