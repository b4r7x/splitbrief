import type { Screen, SlashCommandDef, CommandContext } from './types.js';

const ALL_SCREENS: Screen[] = ['home', 'workflow', 'summary'];

export function createCommands(ctx: CommandContext): SlashCommandDef[] {
  return [
    {
      name: '/help',
      description: 'Show help overlay',
      validScreens: ALL_SCREENS,
      handler: () => ctx.openOverlay('help'),
    },
    {
      name: '/status',
      description: 'Show workflow status',
      validScreens: ALL_SCREENS,
      handler: () => ctx.showStatus(),
    },
    {
      name: '/init',
      description: 'Open setup picker',
      validScreens: ['home'],
      handler: () => ctx.openOverlay('picker'),
    },
    {
      name: '/palette',
      description: 'Open command palette',
      validScreens: ALL_SCREENS,
      handler: () => ctx.openOverlay('command-palette'),
    },
    {
      name: '/sidebar',
      description: 'Toggle sidebar',
      validScreens: ['workflow'],
      handler: () => ctx.toggleSidebar(),
    },
    {
      name: '/quit',
      description: 'Quit application',
      validScreens: ALL_SCREENS,
      handler: () => ctx.quit(),
    },
  ];
}

export function findCommand(commands: SlashCommandDef[], name: string): SlashCommandDef | undefined {
  const lower = name.toLowerCase();
  return commands.find((cmd) => cmd.name.toLowerCase() === lower);
}

export function getCommandsForScreen(commands: SlashCommandDef[], screen: Screen): SlashCommandDef[] {
  return commands.filter((cmd) => cmd.validScreens.includes(screen));
}
