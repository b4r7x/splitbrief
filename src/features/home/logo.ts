export type LogoTier = 'full' | 'compact';

// Rendered once from figlet's 'Standard' (full) and 'Small' (compact) fonts for the
// word "diptych", trailing whitespace trimmed per line, then inlined. Regenerate with
// figlet if the wordmark changes.
export const FULL_LOGO = [
  '      _ _       _              _',
  '   __| (_)_ __ | |_ _   _  ___| |__',
  "  / _` | | '_ \\| __| | | |/ __| '_ \\",
  ' | (_| | | |_) | |_| |_| | (__| | | |',
  '  \\__,_|_| .__/ \\__|\\__, |\\___|_| |_|',
  '         |_|        |___/',
].join('\n');

export const COMPACT_LOGO = [
  '     _ _      _           _',
  '  __| (_)_ __| |_ _  _ __| |_',
  " / _` | | '_ \\  _| || / _| ' \\",
  ' \\__,_|_| .__/\\__|\\_, \\__|_||_|',
  '        |_|       |__/',
].join('\n');

export const LOGO_TAGLINE = 'plan expensively · build cheaply';

const LOGOS: Record<LogoTier, string> = { full: FULL_LOGO, compact: COMPACT_LOGO };

export function getLogo(tier: LogoTier): string {
  return LOGOS[tier];
}

const FULL_LOGO_MIN_COLS = 44;
const FULL_LOGO_MIN_ROWS = 24;

export function getLogoTier(rows: number, cols: number): LogoTier {
  return rows >= FULL_LOGO_MIN_ROWS && cols >= FULL_LOGO_MIN_COLS ? 'full' : 'compact';
}

export function getLogoHeight(tier: LogoTier): number {
  return getLogo(tier).split('\n').length;
}
