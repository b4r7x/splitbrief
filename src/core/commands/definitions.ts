import { Fzf } from 'fzf';
import { ALL_SCREENS, WORKFLOW_MODES } from '../types/index.js';
import type { Screen, SlashCommandDef, CommandContext, CommandPaletteItem } from '../types/index.js';
import { getShortcutKey } from './shortcuts.js';
import { includes } from '../../utils/type-guards.js';

export function createCommands(ctx: CommandContext): SlashCommandDef[] {
  return [
    {
      kind: 'noarg',
      name: '/help',
      label: 'Help',
      description: 'Show help overlay',
      shortcut: getShortcutKey('help'),
      validScreens: ALL_SCREENS,
      handler: () => ctx.openOverlay('help'),
    },
    {
      kind: 'noarg',
      name: '/palette',
      label: 'Palette',
      description: 'Open command palette',
      validScreens: ALL_SCREENS,
      handler: () => ctx.openOverlay('command-palette'),
    },
    {
      kind: 'noarg',
      name: '/skills',
      label: 'Skills',
      description: 'Select planner skills',
      shortcut: getShortcutKey('skills'),
      validScreens: ['home'],
      handler: () => ctx.openOverlay('skills'),
    },
    {
      kind: 'noarg',
      name: '/sessions',
      label: 'Sessions',
      description: 'Browse past sessions',
      validScreens: ALL_SCREENS,
      handler: () => ctx.openOverlay('sessions'),
    },
    {
      kind: 'noarg',
      name: '/settings',
      aliases: ['/config'],
      label: 'Settings',
      description: 'Planner, model & settings',
      shortcut: getShortcutKey('settings'),
      validScreens: ALL_SCREENS,
      handler: () => ctx.openOverlay('settings'),
    },
    {
      kind: 'arg',
      name: '/mode',
      label: 'Mode',
      description: 'Select workflow mode \u2192',
      validScreens: ALL_SCREENS,
      handler: (args) => {
        if (!args) {
          ctx.openOverlay('mode-selector');
          return;
        }
        const mode = args.trim().toLowerCase();
        if (!includes(WORKFLOW_MODES, mode)) {
          ctx.setFeedbackError(`Invalid mode: ${mode}. Valid modes: ${WORKFLOW_MODES.join(', ')}`);
          return;
        }
        if (ctx.setWorkflowMode(mode)) {
          ctx.setFeedbackMessage(`Workflow mode set to: ${mode}`);
        }
      },
    },
    {
      kind: 'noarg',
      name: '/planner',
      label: 'Planner',
      description: 'Select planner tool',
      validScreens: ALL_SCREENS,
      handler: () => ctx.openOverlay('planner-picker'),
    },
    {
      kind: 'noarg',
      name: '/implementer',
      label: 'Implementer',
      description: 'Select implementer',
      validScreens: ALL_SCREENS,
      handler: () => ctx.openOverlay('implementer-picker'),
    },
    {
      kind: 'noarg',
      name: '/home',
      label: 'Home',
      description: 'Return to home screen',
      validScreens: ['workflow', 'summary'],
      handler: () => ctx.navigate('home'),
    },
    {
      kind: 'noarg',
      name: '/refresh',
      label: 'Refresh',
      description: 'Re-detect available tools',
      validScreens: ALL_SCREENS,
      handler: () => {
        ctx.setFeedbackMessage('Refreshing tool detection…');
        ctx.refreshDetection()
          .then(() => ctx.setFeedbackMessage('Tool detection refreshed'))
          .catch(() => ctx.setFeedbackError('Tool detection failed'));
      },
    },
    {
      kind: 'noarg',
      name: '/quit',
      label: 'Quit',
      description: 'Exit application',
      shortcut: getShortcutKey('quit'),
      validScreens: ALL_SCREENS,
      handler: () => ctx.quit(),
    },
  ];
}

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
