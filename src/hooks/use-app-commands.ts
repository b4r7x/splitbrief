import type { Screen, OverlayType, CommandPaletteItem } from '../types.js';
import { createCommands, findCommand } from '../commands.js';
import type { useOverlay } from './use-overlay.js';

const ALL_SCREENS: Screen[] = ['home', 'workflow', 'summary'];

export function useAppCommands(
  overlay: ReturnType<typeof useOverlay>,
  screen: Screen,
  exit: () => void,
  setError: (msg: string | null) => void,
): {
  paletteItems: CommandPaletteItem[];
  handleSlashCommand: (raw: string, from: Screen) => void;
} {
  const ctx = {
    openOverlay: overlay.open,
    closeOverlay: overlay.close,
    toggleSidebar: () => {},
    showStatus: () => setError('No active workflow'),
    quit: () => exit(),
  };

  const commands = createCommands(ctx);

  const paletteItems: CommandPaletteItem[] = [
    { label: 'Help', description: 'Show commands and shortcuts', shortcut: '?', action: () => overlay.open('help'), availableOn: ALL_SCREENS },
    { label: 'Status', description: 'Show workflow progress', shortcut: null, action: () => setError('No active workflow'), availableOn: ALL_SCREENS },
    { label: 'Configure', description: 'Select planner and model', shortcut: null, action: () => overlay.open('picker'), availableOn: ['home'] },
    { label: 'Toggle Sidebar', description: 'Show/hide task sidebar', shortcut: 'Ctrl+\\', action: () => {}, availableOn: ['workflow'] },
    { label: 'Toggle Diff', description: 'Expand/collapse latest diff', shortcut: 'd', action: () => {}, availableOn: ['workflow'] },
    { label: 'Quit', description: 'Exit tiny-spec', shortcut: 'q', action: () => exit(), availableOn: ALL_SCREENS },
  ];

  function handleSlashCommand(raw: string, from: Screen) {
    const name = raw.split(' ')[0].toLowerCase();
    const cmd = findCommand(commands, name);

    if (!cmd) {
      setError(`Unknown command: ${name}. Type /help for available commands.`);
      return;
    }

    if (!cmd.validScreens.includes(from)) {
      setError(`${cmd.name} is only available on the ${cmd.validScreens.join(', ')} screen.`);
      return;
    }

    cmd.handler(ctx);
  }

  return { paletteItems, handleSlashCommand };
}
