import { ALL_SCREENS, WORKFLOW_MODES } from './types.js';
import type { Screen, SlashCommandDef, CommandContext, CommandPaletteItem, WorkflowMode } from './types.js';
import { getShortcutKey } from './shortcuts.js';
import { configStore } from '../stores/config.js';
import { feedbackStore } from '../stores/error.js';

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
      name: '/settings',
      aliases: ['/config'],
      label: 'Settings',
      description: 'Planner, model & settings',
      shortcut: getShortcutKey('settings'),
      validScreens: ALL_SCREENS,
      handler: () => ctx.openOverlay('settings'),
    },
    {
      name: '/mode',
      label: 'Mode',
      description: 'Select workflow mode \u2192',
      validScreens: ALL_SCREENS,
      handler: (args?: string) => {
        const config = configStore.get().config;
        if (!config) return;
        if (!args) {
          ctx.openOverlay('mode-selector');
          return;
        }
        const validModes = WORKFLOW_MODES;
        const mode = args.trim().toLowerCase();
        if (!validModes.includes(mode as WorkflowMode)) {
          feedbackStore.setError(`Invalid mode: ${mode}. Valid modes: ${validModes.join(', ')}`);
          return;
        }
        const updated = { ...config, workflow: { ...config.workflow, mode: mode as WorkflowMode } };
        configStore.save(updated);
        feedbackStore.setMessage(`Workflow mode set to: ${mode}`);
      },
    },
    {
      name: '/planner',
      label: 'Planner',
      description: 'Select planner backend',
      validScreens: ALL_SCREENS,
      handler: () => ctx.openOverlay('planner-picker'),
    },
    {
      name: '/implementer',
      label: 'Implementer',
      description: 'Select implementer backend',
      validScreens: ALL_SCREENS,
      handler: () => ctx.openOverlay('implementer-picker'),
    },
    {
      name: '/home',
      label: 'Home',
      description: 'Return to home screen',
      validScreens: ['workflow', 'summary'],
      handler: () => ctx.navigate('home'),
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
  const parts = raw.split(' ');
  const name = parts[0].toLowerCase();
  const args = parts.slice(1).join(' ').trim() || undefined;
  const cmd = findCommand(commands, name);
  if (!cmd) {
    onError(`Unknown command: ${name}. Type /help for available commands.`);
    return;
  }
  if (!cmd.validScreens.includes(screen)) {
    onError(`${cmd.name} is only available on the ${cmd.validScreens.join(', ')} screen.`);
    return;
  }
  cmd.handler(args);
}
