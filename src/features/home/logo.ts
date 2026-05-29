export type LogoTier = 'full' | 'small' | 'plain';

export const FULL_LOGO = [
  '     _ _       _             _',
  '  __| (_)_ __ | |_ _   _ ___| |__',
  " / _` | | '_ \\| __| | | / __| '_ \\",
  '| (_| | | |_) | |_| |_| \\__ \\ | | |',
  ' \\__,_|_| .__/ \\__|\\__, |___/_| |_|',
  '         |_|       |___/',
].join('\n');

export const SMALL_LOGO = '── diptych ──';

export function getLogoTier(rows: number, cols: number): LogoTier {
  if (rows >= 24 && cols >= 44) return 'full';
  if (rows >= 18) return 'small';
  return 'plain';
}

export function getLogoHeight(tier: LogoTier): number {
  if (tier === 'full') return 6;
  return 1;
}
