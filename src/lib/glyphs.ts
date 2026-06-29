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
  | 'connectorSame'
  | 'connectorHandoff'
  | 'cursor'
  | 'editCursor'
  | 'liveBar'
  | 'prompt'
  | 'scrollThumb'
  | 'scrollTrack'
  | 'treeMid'
  | 'treeBranch'
  | 'treeLast'
  | 'elbow'
  | 'divider'
  | 'check';

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
  connectorSame: '›',
  connectorHandoff: '→',
  cursor: '▸',
  editCursor: '▏',
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
  connectorSame: '>',
  connectorHandoff: '->',
  cursor: '>',
  editCursor: '|',
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
};

export const LINE_SPINNER_FRAMES = ['|', '/', '-', '\\'] as const;
export const BRAILLE_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

const MODERN_TERM_PROGRAMS = new Set(['iTerm.app', 'Apple_Terminal', 'vscode', 'WezTerm']);

// Decide the glyph tier once from terminal capability. Box-drawing and the marker set below render
// on virtually every modern terminal; the ascii tier exists for legacy/uncertain hosts where they
// would mojibake. Pure ASCII is the safe floor: forced on the Linux console, dumb terminals,
// non-Windows-Terminal Windows, and any non-TTY (piped) output. Otherwise a UTF-8 locale (or no
// locale at all, the common modern default) selects the unicode tier.
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

export function borderStyleFor(
  kind: CardKind,
  tier: GlyphTier = resolveGlyphTier(),
): CardBorderStyle {
  return tier === 'unicode' ? kind : 'classic';
}

// Braille spinners are dense and only legible on positively-identified modern hosts; everywhere
// else the line spinner is the portable default.
export function prefersBrailleSpinner(env: NodeJS.ProcessEnv = process.env): boolean {
  if (resolveGlyphTier(env) === 'ascii') return false;
  if (env.WT_SESSION || env.KITTY_WINDOW_ID) return true;
  return MODERN_TERM_PROGRAMS.has(env.TERM_PROGRAM ?? '');
}

export function spinnerFrames(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return prefersBrailleSpinner(env) ? BRAILLE_SPINNER_FRAMES : LINE_SPINNER_FRAMES;
}
