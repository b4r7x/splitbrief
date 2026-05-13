import { getResponsivePanelWidth } from '../../core/layout/terminal-width.js';

interface HomeLayoutInput {
  cols: number;
  rows: number;
  isSmall: boolean;
}

interface HomeLayout {
  inputWidth: number;
  bodyWidth: number;
  showBanner: boolean;
  mainJustifyContent: 'flex-start' | 'center';
  inputBottomMargin: number;
  recentSessionLimit: number;
  recentFeatureColWidth: number;
}

const RECENT_SESSION_LIMITS: ReadonlyArray<{ minRows: number; limit: number }> = [
  { minRows: 38, limit: 8 },
  { minRows: 30, limit: 5 },
  { minRows: 20, limit: 3 },
  { minRows: 18, limit: 2 },
];

function getRecentSessionLimit(rows: number): number {
  for (const tier of RECENT_SESSION_LIMITS) {
    if (rows >= tier.minRows) return tier.limit;
  }
  return 0;
}

export function getHomeLayout({ cols, rows, isSmall }: HomeLayoutInput): HomeLayout {
  const inputWidth = getResponsivePanelWidth(cols, isSmall, { small: 70, large: 92 }, 8);
  const bodyWidth = isSmall ? inputWidth : Math.min(inputWidth, 72);
  const recentSessionLimit = getRecentSessionLimit(rows);
  const recentFeatureColWidth = Math.min(bodyWidth, Math.max(8, bodyWidth - 12));

  return {
    inputWidth,
    bodyWidth,
    showBanner: rows >= 18,
    mainJustifyContent: rows >= 20 ? 'center' : 'flex-start',
    inputBottomMargin: rows >= 38 ? 2 : rows >= 30 ? 1 : 0,
    recentSessionLimit,
    recentFeatureColWidth,
  };
}
