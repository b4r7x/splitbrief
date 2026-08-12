import type { MarkdownLayoutGlyphs } from '../utils/markdown/types.js';

export type GlyphTier = 'unicode' | 'ascii';

export type GlyphName =
  | 'stagePending'
  | 'stageActive'
  | 'stageDone'
  | 'statusDone'
  | 'statusFailed'
  | 'statusEscalated'
  | 'statusInProgress'
  | 'statusPending'
  | 'statusCancelled'
  | 'statusSkipped'
  | 'statusWarning'
  | 'connectorSame'
  | 'connectorHandoff'
  | 'wrapContinuation'
  | 'cursor'
  | 'editCursor'
  | 'codeRail'
  | 'listBullet'
  | 'listBulletNested'
  | 'tableColumn'
  | 'liveBar'
  | 'prompt'
  | 'scrollThumb'
  | 'scrollTrack'
  | 'treeMid'
  | 'treeBranch'
  | 'treeLast'
  | 'elbow'
  | 'divider'
  | 'check'
  | 'promptMarker';

export type CardKind = 'round' | 'single' | 'bold';
export type CardBorderStyle = 'round' | 'single' | 'bold' | 'classic';

const UNICODE_GLYPHS: Record<GlyphName, string> = {
  stagePending: '○',
  stageActive: '◉',
  stageDone: '●',
  statusDone: '*',
  statusFailed: '✗',
  statusEscalated: '▲',
  statusInProgress: '◉',
  statusPending: '○',
  statusCancelled: '×',
  statusSkipped: '–',
  statusWarning: '⚠',
  connectorSame: '›',
  connectorHandoff: '→',
  wrapContinuation: '↪',
  cursor: '▸',
  editCursor: '▏',
  codeRail: '▏',
  listBullet: '•',
  listBulletNested: '◦',
  tableColumn: '│',
  liveBar: '▌',
  prompt: '›',
  scrollThumb: '█',
  scrollTrack: '│',
  treeMid: '│',
  treeBranch: '├',
  treeLast: '└',
  elbow: '└─',
  divider: '─',
  check: '✓',
  promptMarker: '❯',
};

const ASCII_GLYPHS: Record<GlyphName, string> = {
  stagePending: 'o',
  stageActive: '@',
  stageDone: '*',
  statusDone: '*',
  statusFailed: 'x',
  statusEscalated: '!',
  statusInProgress: '@',
  statusPending: 'o',
  statusCancelled: 'x',
  statusSkipped: '-',
  statusWarning: '!',
  connectorSame: '>',
  connectorHandoff: '->',
  wrapContinuation: '>>',
  cursor: '>',
  editCursor: '|',
  codeRail: '|',
  listBullet: '*',
  listBulletNested: '-',
  tableColumn: '|',
  liveBar: '|',
  prompt: '>',
  scrollThumb: '#',
  scrollTrack: '|',
  treeMid: '|',
  treeBranch: '+',
  treeLast: '\\',
  elbow: '\\-',
  divider: '-',
  check: '+',
  promptMarker: '>',
};

export const LINE_SPINNER_FRAMES = ['|', '/', '-', '\\'] as const;
export const BRAILLE_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

// Decide the glyph tier once from terminal capability. Box-drawing and the marker set below render
// on virtually every modern terminal; the ascii tier exists for legacy/uncertain hosts where they
// would mojibake. It is forced on the Linux console, dumb terminals, non-Windows-Terminal Windows,
// and any non-TTY (piped) output; otherwise a UTF-8 locale (or no locale at all, the common modern
// default) selects the unicode tier.
//
// What the ascii tier guarantees is exactly this table: no box-drawing and no non-ASCII marker from
// `glyph()`. It is not a whole-product ASCII floor, and must not be read as one — the truncation
// ellipsis (`ELLIPSIS` in `utils/display-text.ts`) and the `·` run separator (`SOFT_SEP` in
// `components/separators.ts`) are untiered constants that render the same at both tiers, so a host
// that mojibakes `─` mojibakes those too. Tiering them means routing every call site through
// `glyph()`, including the measured hot path in `display-text.ts`; that is a real change with no
// observed defect behind it yet, and it is tracked rather than done here.
export function resolveGlyphTier(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = Boolean(process.stdout?.isTTY),
): GlyphTier {
  if (env.TERM === 'linux' || env.TERM === 'dumb') return 'ascii';
  if (process.platform === 'win32' && !env.WT_SESSION) return 'ascii';
  if (!isTTY) return 'ascii';
  const locale = `${env.LC_ALL ?? ''} ${env.LC_CTYPE ?? ''} ${env.LANG ?? ''}`.toLowerCase();
  if (locale.includes('utf-8') || locale.includes('utf8')) return 'unicode';
  if (locale.trim() === '') return 'unicode';
  return 'ascii';
}

export function glyph(name: GlyphName, tier: GlyphTier = resolveGlyphTier()): string {
  return (tier === 'ascii' ? ASCII_GLYPHS : UNICODE_GLYPHS)[name];
}

// Markdown layout lives in `utils/`, the leaf layer, so it cannot reach the glyph table itself.
// Callers resolve the tier once here and hand the bundle down with the width.
export function markdownLayoutGlyphs(tier: GlyphTier = resolveGlyphTier()): MarkdownLayoutGlyphs {
  return {
    codeRail: glyph('codeRail', tier),
    wrapContinuation: glyph('wrapContinuation', tier),
    divider: glyph('divider', tier),
    listBullet: glyph('listBullet', tier),
    listBulletNested: glyph('listBulletNested', tier),
    tableColumn: glyph('tableColumn', tier),
  };
}

export function borderStyleFor(
  kind: CardKind,
  tier: GlyphTier = resolveGlyphTier(),
): CardBorderStyle {
  return tier === 'unicode' ? kind : 'classic';
}

// Braille renders on every unicode-tier host; only the ascii tier falls back to the portable line
// spinner.
export function prefersBrailleSpinner(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveGlyphTier(env) !== 'ascii';
}

export function spinnerFrames(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return prefersBrailleSpinner(env) ? BRAILLE_SPINNER_FRAMES : LINE_SPINNER_FRAMES;
}
