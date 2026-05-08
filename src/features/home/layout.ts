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

export function getHomeLayout({ cols, rows, isSmall }: HomeLayoutInput): HomeLayout {
  const inputWidth = getResponsivePanelWidth(cols, isSmall, { small: 70, large: 92 }, 8);
  const bodyWidth = isSmall ? inputWidth : Math.min(inputWidth, 72);
  const recentSessionLimit = rows >= 38 ? 8 : rows >= 30 ? 5 : rows >= 20 ? 3 : rows >= 18 ? 2 : 0;
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
