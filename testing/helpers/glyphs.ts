export function forceUnicodeGlyphs(): void {
  process.env.TERM = 'xterm-256color';
  process.env.LANG = 'en_US.UTF-8';
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
}
