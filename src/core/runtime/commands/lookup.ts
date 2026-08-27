import { Fzf } from 'fzf';
import { REMOVED_COMMANDS, type RuntimeCommandDef } from './types.js';

export interface RuntimeCommandMatch {
  command: RuntimeCommandDef;
  aliasArgs?: string;
}

export function findRuntimeCommand(
  commands: RuntimeCommandDef[],
  name: string,
): RuntimeCommandMatch | null {
  const lower = name.toLowerCase();
  const exact = commands.find((command) => command.name.toLowerCase() === lower);
  if (exact) return { command: exact };
  for (const command of commands) {
    const alias = command.aliases?.find((a) => a.name.toLowerCase() === lower);
    if (alias) return { command, ...(alias.args !== undefined && { aliasArgs: alias.args }) };
  }
  return null;
}

export function removedCommandPointer(name: string): string | undefined {
  const key = name.toLowerCase();
  return Object.hasOwn(REMOVED_COMMANDS, key) ? REMOVED_COMMANDS[key] : undefined;
}

export function suggestRuntimeCommand(
  commands: RuntimeCommandDef[],
  query: string,
): RuntimeCommandDef | null {
  const bare = query.startsWith('/') ? query.slice(1) : query;
  if (!bare) return null;
  const fzf = new Fzf(commands, { selector: (c: RuntimeCommandDef) => c.name.slice(1) });
  const results = fzf.find(bare);
  const top = results[0];
  return top !== undefined && top.score > 0 ? top.item : null;
}
