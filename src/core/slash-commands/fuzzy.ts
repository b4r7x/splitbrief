import { Fzf } from 'fzf';
import type { SlashCommandDef } from './types.js';

export function findCommand(
  commands: SlashCommandDef[],
  name: string,
): SlashCommandDef | null {
  const lower = name.toLowerCase();
  return commands.find((cmd) =>
    cmd.name.toLowerCase() === lower || cmd.aliases?.some(a => a.toLowerCase() === lower),
  ) ?? null;
}

export function fuzzyMatchCommand(
  commands: SlashCommandDef[],
  query: string,
): SlashCommandDef | null {
  const bare = query.startsWith('/') ? query.slice(1) : query;
  if (!bare) return null;
  const fzf = new Fzf(commands, { selector: (c: SlashCommandDef) => c.name.slice(1) });
  const results = fzf.find(bare);
  const top = results[0];
  return top !== undefined && top.score > 0 ? top.item : null;
}

export function lookupCommand(
  commands: SlashCommandDef[],
  query: string,
): SlashCommandDef | null {
  return findCommand(commands, query) ?? fuzzyMatchCommand(commands, query);
}
