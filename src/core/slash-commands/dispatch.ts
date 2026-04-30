import type { Phase } from '../schemas/enums.js';
import type { Screen } from '../navigation/types.js';
import type { SlashCommandDef, CommandPaletteItem } from './types.js';
import { lookupCommand } from './fuzzy.js';

interface CommandExecutionOptions {
  screen: Screen;
  phase: Phase;
  onError: (msg: string) => void;
}

export function toPaletteItems(
  commands: SlashCommandDef[],
  options: CommandExecutionOptions,
): CommandPaletteItem[] {
  return commands
    .filter((cmd): cmd is SlashCommandDef & { label: string } => !!cmd.label)
    .map(cmd => ({
      label: cmd.label,
      description: cmd.description,
      shortcut: cmd.shortcut ?? null,
      action: () => executeSlashCommand(commands, cmd.name, options),
      availableOn: cmd.validScreens,
    }));
}

export async function executeSlashCommand(
  commands: SlashCommandDef[],
  raw: string,
  options: CommandExecutionOptions,
): Promise<void> {
  const parts = raw.split(' ');
  const name = (parts[0] ?? '').toLowerCase();
  const args = parts.slice(1).join(' ').trim() || undefined;
  const cmd = lookupCommand(commands, name);
  if (!cmd) {
    options.onError(`Unknown command: ${name}. Type /help for available commands.`);
    return;
  }
  if (!cmd.validScreens.includes(options.screen)) {
    options.onError(`${cmd.name} is only available on the ${cmd.validScreens.join(', ')} screen.`);
    return;
  }
  if (cmd.phaseGuard && !cmd.phaseGuard(options.phase)) {
    options.onError(`${cmd.name} is not available during the ${options.phase} phase.`);
    return;
  }

  try {
    if (cmd.kind === 'arg') await cmd.handler(args);
    else await cmd.handler();
  } catch (err) {
    options.onError(err instanceof Error ? err.message : String(err));
  }
}
