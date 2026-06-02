import { getResponsivePanelWidth } from '../../utils/terminal-width.js';
import { getLogoTier, getLogoHeight, type LogoTier } from './logo.js';

interface HomeLayoutInput {
  cols: number;
  rows: number;
  isSmall: boolean;
}

interface HomeLayout {
  inputWidth: number;
  bodyWidth: number;
  logoTier: LogoTier;
  inputBottomMargin: number;
  recentSessionLimit: number;
  recentFeatureColWidth: number;
}

interface SessionLimitInput {
  rows: number;
  isSmall: boolean;
  logoTier: LogoTier;
  inputBottomMargin: number;
}

function getContentAwareSessionLimit(input: SessionLimitInput): number {
  const { rows, isSmall, logoTier, inputBottomMargin } = input;
  if (rows < 18) return 0;
  const logoHeight = getLogoHeight(logoTier);
  const overhead = isSmall
    ? logoHeight + 1 + 2 + 4 + 2
    : logoHeight + 1 + 4 + 2 + 4 + inputBottomMargin + 2;
  const available = rows - overhead;
  return Math.max(0, Math.min(available, 12));
}

export function getHomeLayout({ cols, rows, isSmall }: HomeLayoutInput): HomeLayout {
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
  });
  const recentFeatureColWidth = Math.min(bodyWidth, Math.max(8, bodyWidth - 12));

  return {
    inputWidth,
    bodyWidth,
    logoTier,
    inputBottomMargin,
    recentSessionLimit,
    recentFeatureColWidth,
  };
}
