import { ALL_SCREENS } from '../navigation/types.js';
import type { Screen } from '../navigation/types.js';

interface ShortcutInfo {
  id: string;
  key: string;
  description: string;
  screens: readonly Screen[];
}

const SHORTCUTS: ShortcutInfo[] = [
  { id: 'exit', key: 'Ctrl+C', description: 'Exit (double-press)', screens: ALL_SCREENS },
  { id: 'command-palette', key: 'Ctrl+K', description: 'Command palette', screens: ALL_SCREENS },
  { id: 'help', key: 'Ctrl+/', description: 'Help', screens: ALL_SCREENS },
  { id: 'quit', key: 'Ctrl+Q', description: 'Quit', screens: ALL_SCREENS },
  { id: 'skills', key: 'Ctrl+S', description: 'Skills picker', screens: ['home'] },
  { id: 'config', key: 'Ctrl+I', description: 'Config picker', screens: ['home'] },
  { id: 'settings', key: 'Ctrl+,', description: 'Settings', screens: ALL_SCREENS },
  { id: 'close-overlay', key: 'Escape', description: 'Close overlay', screens: ALL_SCREENS },
  { id: 'toggle-sidebar', key: 'Ctrl+E', description: 'Toggle sidebar', screens: ['workflow'] },
  { id: 'toggle-diff', key: 'Ctrl+D', description: 'Toggle diff', screens: ['workflow'] },
  { id: 'scroll', key: '↑/↓', description: 'Scroll', screens: ['workflow'] },
  { id: 'continue', key: 'Enter', description: 'Continue', screens: ['summary'] },
];

export function getShortcutKey(id: string): string | null {
  return SHORTCUTS.find(s => s.id === id)?.key ?? null;
}

export function getShortcutsForScreen(screen: Screen): ShortcutInfo[] {
  return SHORTCUTS.filter((s) => s.screens.includes(screen));
}
