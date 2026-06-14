import { parseShellCommand } from '../../utils/parse-shell-command.js';

export function resolveEditorArgv(): { command: string; args: string[] } {
  const raw = (process.env.VISUAL?.trim() || process.env.EDITOR?.trim() || 'vi').trim();
  const tokens = parseShellCommand(raw);
  if (tokens.length === 0) return { command: 'vi', args: [] };
  const [command, ...args] = tokens;
  if (!command) return { command: 'vi', args: [] };
  return { command, args };
}
