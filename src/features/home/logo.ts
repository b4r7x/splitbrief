export type LogoTier = 'full' | 'compact';

// Rendered once from figlet's Standard and Small fonts for the product wordmark.
const FULL_LOGO = [
  ' ____        _ _ _   _          _       __',
  '/ ___| _ __ | (_) |_| |__  _ __(_) ___ / _|',
  "\\___ \\| '_ \\| | | __| '_ \\| '__| |/ _ \\ |_",
  ' ___) | |_) | | | |_| |_) | |  | |  __/  _|',
  '|____/| .__/|_|_|\\__|_.__/|_|  |_|\\___|_|',
  '      |_|',
].join('\n');

const COMPACT_LOGO = [
  ' ___      _ _ _   _        _      __',
  '/ __|_ __| (_) |_| |__ _ _(_)___ / _|',
  "\\__ \\ '_ \\ | |  _| '_ \\ '_| / -_)  _|",
  '|___/ .__/_|_|\\__|_.__/_| |_\\___|_|',
  '    |_|',
].join('\n');

const LOGOS: Record<LogoTier, string> = { full: FULL_LOGO, compact: COMPACT_LOGO };

export function getLogo(tier: LogoTier): string {
  return LOGOS[tier];
}

const FULL_LOGO_MIN_COLS = 51;
const FULL_LOGO_MIN_ROWS = 24;

export function getLogoTier(rows: number, cols: number): LogoTier {
  return rows >= FULL_LOGO_MIN_ROWS && cols >= FULL_LOGO_MIN_COLS ? 'full' : 'compact';
}

export function getLogoHeight(tier: LogoTier): number {
  return getLogo(tier).split('\n').length;
}
