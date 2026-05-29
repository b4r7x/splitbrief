import { Fzf } from 'fzf';
import type { RuntimeCommandDef } from './types.js';

export function findRuntimeCommand(
  commands: RuntimeCommandDef[],
  name: string,
): RuntimeCommandDef | null {
  const lower = name.toLowerCase();
  return (
    commands.find(
      (cmd) =>
        cmd.name.toLowerCase() === lower || cmd.aliases?.some((a) => a.toLowerCase() === lower),
    ) ?? null
  );
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

export function lookupRuntimeCommand(
  commands: RuntimeCommandDef[],
  query: string,
): RuntimeCommandDef | null {
  return findRuntimeCommand(commands, query) ?? suggestRuntimeCommand(commands, query);
}
