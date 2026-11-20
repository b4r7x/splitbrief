import { overlayWidth } from '../../core/navigation/overlay-rect.js';
import { wrapHard } from '../../utils/display-text/wrap.js';
import { MARK_SLOT_CELLS } from '../../components/row-leading.js';
import { getLogoTier, getLogoHeight, getLogoWidth, type LogoTier } from './logo.js';
import type { HomeToolCheck } from './tool-check.js';

interface HomeLayoutInput {
  cols: number;
  rows: number;
  sessionCount?: number;
  sessionsFocused?: boolean | undefined;
  /** Rows the composer paints under the body: the home row, its message rows and the box. */
  dockRows: number;
  noConfig: boolean;
}

interface HomeLayout {
  width: number;
  /** The heading over the crew block, or none when even the wordmark would cut the crew block. */
  heading: LogoTier | null;
  inputBottomMargin: number;
  recentSessionLimit: number;
  showHiddenCount: boolean;
  /** Rows the session list may spend; unspent rows are the body's slack. */
  sessionCapacity: number;
}

interface SessionLimitInput {
  cols: number;
  rows: number;
  heading: LogoTier | null;
  inputBottomMargin: number;
  dockRows: number;
  noticeRows: number;
  sessionCount: number;
  sessionsFocused: boolean;
}

interface SessionLimit {
  recentSessionLimit: number;
  showHiddenCount: boolean;
  sessionCapacity: number;
  crewFits: boolean;
}

const FOCUSED_FILTER_BLOCK_ROWS = 4;
const COMPACT_CONFIG_BLOCK_ROWS = 2;
const HOME_MAX_WIDTH = 108;
// The home row over a one-row input box.
export const RESTING_DOCK_ROWS = 4;
// The blank rows at the foot of a resting body: its spare row and the session list's bottom
// margin. A taller dock and the No config notice take these before they take any content.
const BODY_SLACK_ROWS = 2;
export const NO_CONFIG_NOTICE = 'No config. Setup saves .splitbrief/config.yaml.';

// A logo has the body gap under it; the wordmark sits on the crew block's first row.
export function homeHeadingRows(heading: LogoTier | null): number {
  return heading === null ? 0 : heading === 'wordmark' ? 1 : getLogoHeight(heading) + 1;
}

export function homeConfigBlockRows(rows: number): number {
  return rows >= 24 ? 4 : COMPACT_CONFIG_BLOCK_ROWS;
}

function getContentAwareSessionLimit(input: SessionLimitInput): SessionLimit {
  const { cols, rows, heading, inputBottomMargin, dockRows } = input;
  const { noticeRows, sessionCount, sessionsFocused } = input;
  const slackRows = Math.max(0, BODY_SLACK_ROWS - (dockRows - RESTING_DOCK_ROWS) - noticeRows);
  const logoBlock = homeHeadingRows(heading);
  const crewRows = rows - (inputBottomMargin + dockRows + slackRows + noticeRows + logoBlock);
  const configBlock = homeConfigBlockRows(rows);
  const crewFits = crewRows >= configBlock;
  const sessionsChrome = 1 + 1 + (cols >= 120 ? 1 : 0);
  const baseCapacity = Math.max(0, crewRows - configBlock - sessionsChrome);
  if (sessionsFocused) {
    const capacity = Math.max(0, baseCapacity - FOCUSED_FILTER_BLOCK_ROWS);
    return {
      recentSessionLimit: capacity,
      showHiddenCount: false,
      sessionCapacity: capacity,
      crewFits,
    };
  }
  if (sessionCount <= baseCapacity) {
    return {
      recentSessionLimit: baseCapacity,
      showHiddenCount: false,
      sessionCapacity: baseCapacity,
      crewFits,
    };
  }
  if (baseCapacity <= 1) {
    return {
      recentSessionLimit: baseCapacity,
      showHiddenCount: false,
      sessionCapacity: baseCapacity,
      crewFits,
    };
  }
  return {
    recentSessionLimit: baseCapacity - 1,
    showHiddenCount: true,
    sessionCapacity: baseCapacity,
    crewFits,
  };
}

function shownSessionRows(
  limit: Pick<SessionLimit, 'recentSessionLimit' | 'showHiddenCount'>,
  sessionCount: number,
): number {
  return Math.min(sessionCount, limit.recentSessionLimit) + (limit.showHiddenCount ? 1 : 0);
}

// The crew block outranks the logo, and so do the first session row and its count row: the logo
// gives way when keeping it would cut the crew block, or would leave the list fewer rows than it
// shows over a resting dock, down to a row and its count. A logo wider than the body would wrap,
// so it gives way too. A focused list takes the wordmark when that shows it more sessions. The
// wordmark costs one row, so it gives way only when it would cut the crew block itself.
export function getHomeLayout({
  cols,
  rows,
  sessionCount = 0,
  sessionsFocused = false,
  dockRows,
  noConfig,
}: HomeLayoutInput): HomeLayout {
  const width = Math.min(overlayWidth({ cols, density: 'wide' }), HOME_MAX_WIDTH);
  const logoTier = getLogoTier(rows, cols);
  const inputBottomMargin = rows >= 38 ? 2 : rows >= 30 ? 1 : 0;
  // The notice wraps as its Text does inside the crew block's indent, and the body column's gap
  // adds a row under it.
  const noticeRows = noConfig
    ? wrapHard(NO_CONFIG_NOTICE, width - MARK_SLOT_CELLS).split('\n').length + 1
    : 0;
  const plan = {
    cols,
    rows,
    logoTier,
    inputBottomMargin,
    noticeRows,
    sessionCount,
    sessionsFocused,
  };
  const withLogo = getContentAwareSessionLimit({ ...plan, heading: logoTier, dockRows });
  const resting = getContentAwareSessionLimit({
    ...plan,
    heading: logoTier,
    dockRows: RESTING_DOCK_ROWS,
  });
  const withWordmark = getContentAwareSessionLimit({ ...plan, heading: 'wordmark', dockRows });
  const logoShown = shownSessionRows(withLogo, sessionCount);
  const keepsLogo =
    getLogoWidth(logoTier) <= width &&
    withLogo.crewFits &&
    logoShown >= Math.min(shownSessionRows(resting, sessionCount), 2) &&
    !(sessionsFocused && shownSessionRows(withWordmark, sessionCount) > logoShown);
  const heading = keepsLogo
    ? logoTier
    : getLogoWidth('wordmark') <= width && withWordmark.crewFits
      ? 'wordmark'
      : null;
  const { recentSessionLimit, showHiddenCount, sessionCapacity } =
    heading === logoTier
      ? withLogo
      : heading === 'wordmark'
        ? withWordmark
        : getContentAwareSessionLimit({ ...plan, heading: null, dockRows });

  return {
    width,
    heading,
    inputBottomMargin,
    recentSessionLimit,
    showHiddenCount,
    sessionCapacity,
  };
}

// A crew of three seats wraps onto at most one row per seat.
const CREW_EXTRA_ROWS = 2;

/** Below this height the box would crowd out sessions; the hint line takes over. */
const DISCOVERY_PANEL_MIN_ROWS = 24;
/** The box's three rows plus one breathing row — the slack the box needs to render whole. */
const DISCOVERY_PANEL_SLACK_ROWS = 4;

interface HomeLayoutStateInput {
  cols: number;
  rows: number;
  /** The run count that the session budget counts. */
  sessionCount: number;
  /** The runs the list can show and focus. */
  listedSessions: number;
  sessionsFocused: boolean;
  dockRows: number;
  noConfig: boolean;
  toolCheck: HomeToolCheck;
}

interface HomeLayoutState {
  layout: HomeLayout;
  hasRoomForSessions: boolean;
  canFocus: boolean;
  sessionsActive: boolean;
  discoveryPanelFits: boolean;
  /** The running tool check shows on the hint line, not in its box. */
  hintNotice: boolean;
  /** The rows the collapsed crew may wrap onto: its own row and the session rows nothing fills. */
  seatLineRows: number;
}

export function deriveHomeLayoutState({
  cols,
  rows,
  sessionCount,
  listedSessions,
  sessionsFocused,
  dockRows,
  noConfig,
  toolCheck,
}: HomeLayoutStateInput): HomeLayoutState {
  const screen = { cols, rows, sessionCount, dockRows, noConfig };
  const preliminaryLayout = getHomeLayout({ ...screen, sessionsFocused: false });
  const focusedLayout = getHomeLayout({ ...screen, sessionsFocused: true });
  const hasRoomForSessions = preliminaryLayout.recentSessionLimit > 0;
  const canFocus = focusedLayout.recentSessionLimit > 0 && listedSessions > 0;
  const sessionsActive = sessionsFocused && canFocus;
  const layout = sessionsActive ? focusedLayout : preliminaryLayout;
  // The box needs real slack below the rendered session rows, or it would be
  // clipped to a partial slice; without slack the hint line carries the notice.
  const renderedSessionRows = hasRoomForSessions ? shownSessionRows(layout, listedSessions) : 0;
  const discoveryPanelFits =
    rows >= DISCOVERY_PANEL_MIN_ROWS &&
    layout.sessionCapacity - renderedSessionRows >= DISCOVERY_PANEL_SLACK_ROWS;
  const hintNotice = toolCheck === 'warm' || (toolCheck === 'cold' && !discoveryPanelFits);
  const seatLineRows =
    1 + Math.min(CREW_EXTRA_ROWS, Math.max(0, layout.sessionCapacity - renderedSessionRows));
  return {
    layout,
    hasRoomForSessions,
    canFocus,
    sessionsActive,
    discoveryPanelFits,
    hintNotice,
    seatLineRows,
  };
}
