import { scanShellWords } from './parse-shell-command.js';

const SHELL_COMMANDS = new Set(['/bin/zsh', '/bin/bash', '/bin/sh', 'zsh', 'bash', 'sh']);

export function shellQuoteArg(arg: string): string {
  if (arg.length === 0) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function shellCommandFromText(text: string): string | null {
  const { words, complete } = scanShellWords(text);
  const [shell, option, command] = words;
  if (shell === undefined || !SHELL_COMMANDS.has(shell) || option !== '-lc') return null;
  if (!complete) return text.trim();
  return command === undefined || command.length === 0 ? null : command;
}
