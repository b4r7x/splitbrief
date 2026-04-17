import { Fzf } from 'fzf';
import type { Screen, SlashCommandDef, CommandPaletteItem } from '../types/index.js';

function findCommand(commands: SlashCommandDef[], name: string): SlashCommandDef | undefined {
  const lower = name.toLowerCase();
  return commands.find((cmd) =>
    cmd.name.toLowerCase() === lower || cmd.aliases?.some(a => a.toLowerCase() === lower),
  );
}

export function toPaletteItems(commands: SlashCommandDef[]): CommandPaletteItem[] {
  return commands
    .filter((cmd): cmd is SlashCommandDef & { label: string } => !!cmd.label)
    .map(cmd => ({
      label: cmd.label,
      description: cmd.description,
      shortcut: cmd.shortcut ?? null,
      action: () => { if (cmd.kind === 'arg') cmd.handler(undefined); else cmd.handler(); },
      availableOn: cmd.validScreens,
    }));
}

function fuzzyFindCommand(commands: SlashCommandDef[], name: string): SlashCommandDef | undefined {
  const bare = name.startsWith('/') ? name.slice(1) : name;
  if (!bare) return undefined;
  const fzf = new Fzf(commands, { selector: (c: SlashCommandDef) => c.name.slice(1) });
  const results = fzf.find(bare);
  const top = results[0];
  return top !== undefined && top.score > 0 ? top.item : undefined;
}

export function executeSlashCommand(
  commands: SlashCommandDef[],
  raw: string,
  screen: Screen,
  onError: (msg: string) => void,
): void {
  const parts = raw.split(' ');
  const name = (parts[0] ?? '').toLowerCase();
  const args = parts.slice(1).join(' ').trim() || undefined;
  const cmd = findCommand(commands, name) ?? fuzzyFindCommand(commands, name);
  if (!cmd) {
    onError(`Unknown command: ${name}. Type /help for available commands.`);
    return;
  }
  if (!cmd.validScreens.includes(screen)) {
    onError(`${cmd.name} is only available on the ${cmd.validScreens.join(', ')} screen.`);
    return;
  }
  if (cmd.kind === 'arg') cmd.handler(args);
  else cmd.handler();
}
