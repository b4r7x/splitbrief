import { ALL_SCREENS } from './types.js';
import type { Screen, SlashCommandDef, CommandContext, CommandPaletteItem } from './types.js';
import { getShortcutKey } from './shortcuts.js';

export function createCommands(ctx: CommandContext): SlashCommandDef[] {
  return [
    {
      name: '/help',
      label: 'Help',
      description: 'Show help overlay',
      shortcut: getShortcutKey('help'),
      validScreens: ALL_SCREENS,
      handler: () => ctx.openOverlay('help'),
    },
    {
      name: '/status',
      label: 'Status',
      description: 'Show workflow status',
      validScreens: ALL_SCREENS,
      handler: () => ctx.showStatus(),
    },
    {
      name: '/palette',
      label: 'Palette',
      description: 'Open command palette',
      validScreens: ALL_SCREENS,
      handler: () => ctx.openOverlay('command-palette'),
    },
    {
      name: '/skills',
      label: 'Skills',
      description: 'Select planner skills',
      shortcut: getShortcutKey('skills'),
      validScreens: ['home'],
      handler: () => ctx.openOverlay('skills'),
    },
    {
      name: '/quit',
      label: 'Quit',
      description: 'Exit application',
      shortcut: getShortcutKey('quit'),
      validScreens: ALL_SCREENS,
      handler: () => ctx.quit(),
    },
  ];
}

export function findCommand(commands: SlashCommandDef[], name: string): SlashCommandDef | undefined {
  const lower = name.toLowerCase();
  return commands.find((cmd) => cmd.name.toLowerCase() === lower);
}

export function toPaletteItems(commands: SlashCommandDef[]): CommandPaletteItem[] {
  return commands
    .filter((cmd): cmd is SlashCommandDef & { label: string } => !!cmd.label)
    .map(cmd => ({
      label: cmd.label,
      description: cmd.description,
      shortcut: cmd.shortcut ?? null,
      action: cmd.handler,
      availableOn: cmd.validScreens,
    }));
}

export function executeSlashCommand(
  commands: SlashCommandDef[],
  raw: string,
  screen: Screen,
  onError: (msg: string) => void,
): void {
  const name = raw.split(' ')[0].toLowerCase();
  const cmd = findCommand(commands, name);
  if (!cmd) {
    onError(`Unknown command: ${name}. Type /help for available commands.`);
    return;
  }
  if (!cmd.validScreens.includes(screen)) {
    onError(`${cmd.name} is only available on the ${cmd.validScreens.join(', ')} screen.`);
    return;
  }
  cmd.handler();
}
