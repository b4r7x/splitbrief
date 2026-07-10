const HYPERLINK_TERM_PROGRAMS = new Set(['iTerm.app', 'WezTerm', 'ghostty', 'vscode', 'Hyper']);
const HYPERLINK_TERMS = new Set(['xterm-kitty', 'foot', 'alacritty']);

// In-house sniffing (no hyperlink-detection dependency, by decision). FORCE_HYPERLINK follows the
// ecosystem convention: '0'/'false' forces off, any other non-empty value forces on (test lever).
export function terminalSupportsHyperlinks(env: NodeJS.ProcessEnv = process.env): boolean {
  const force = env['FORCE_HYPERLINK'];
  if (force !== undefined && force !== '') return force !== '0' && force !== 'false';
  const termProgram = env['TERM_PROGRAM'] ?? '';
  if (termProgram === 'Apple_Terminal') return false;
  if (HYPERLINK_TERM_PROGRAMS.has(termProgram)) return true;
  if (Number.parseInt(env['VTE_VERSION'] ?? '', 10) >= 5000) return true;
  if (env['KITTY_WINDOW_ID'] !== undefined) return true;
  if (env['WT_SESSION'] !== undefined) return true;
  return HYPERLINK_TERMS.has(env['TERM'] ?? '');
}

export function osc8Hyperlink(input: { label: string; href: string }): string {
  return `\x1b]8;;${input.href}\x1b\\${input.label}\x1b]8;;\x1b\\`;
}
