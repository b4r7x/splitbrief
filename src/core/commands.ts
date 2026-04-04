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
      name: '/config',
      label: 'Config',
      description: 'Change planner & model',
      shortcut: getShortcutKey('config'),
      validScreens: ['home'],
      handler: () => ctx.openOverlay('picker'),
    },
    {
      name: '/settings',
      label: 'Settings',
      description: 'Open settings',
      shortcut: getShortcutKey('settings'),
      validScreens: ALL_SCREENS,
      handler: () => ctx.openOverlay('settings'),
    },
    {
      name: '/mode',
      label: 'Mode',
      description: 'Show or set workflow mode (quick, standard, full)',
      validScreens: ALL_SCREENS,
      handler: (args?: string) => {
        const config = configStore.get().config;
        if (!config) return;
        const validModes = WORKFLOW_MODES;
        if (!args) {
          const current = config.workflow.mode ?? 'standard';
          feedbackStore.setMessage(`Workflow mode: ${current}. Use /mode <${validModes.join('|')}> to change.`);
          return;
        }
        const mode = args.trim().toLowerCase();
        if (!validModes.includes(mode as WorkflowMode)) {
          feedbackStore.setError(`Invalid mode: ${mode}. Valid modes: ${validModes.join(', ')}`);
          return;
        }
        const updated = { ...config, workflow: { ...config.workflow, mode: mode as WorkflowMode } };
        configStore.set({ ...configStore.get(), config: updated });
        feedbackStore.setMessage(`Workflow mode set to: ${mode}`);
      },
    },
    {
      name: '/model',
      label: 'Model',
      description: 'Show current planner and implementer model config',
      validScreens: ALL_SCREENS,
      handler: () => {
        const config = configStore.get().config;
        if (!config) return;
        const plannerInfo = `Planner: ${config.planner.tool}${config.planner.model ? ` (${config.planner.model})` : ''}`;
        const implInfo = `Implementer: ${config.implementer.model} (${config.implementer.provider})`;
        feedbackStore.setMessage(`${plannerInfo} | ${implInfo}`);
      },
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
