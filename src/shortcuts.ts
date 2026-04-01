import type { Screen } from './types.js';
import { ALL_SCREENS } from './types.js';

export interface ShortcutInfo {
  id?: string;
  key: string;
  description: string;
  screens: Screen[];
}

export const SHORTCUTS: ShortcutInfo[] = [
  { key: 'Ctrl+C', description: 'Exit (double-press)', screens: ALL_SCREENS },
  { key: 'Ctrl+K', description: 'Command palette', screens: ALL_SCREENS },
  { id: 'help', key: 'Ctrl+/', description: 'Help', screens: ALL_SCREENS },
  { id: 'quit', key: 'Ctrl+Q', description: 'Quit', screens: ALL_SCREENS },
  { id: 'skills', key: 'Ctrl+S', description: 'Skills picker', screens: ['home'] },
  { key: 'Escape', description: 'Close overlay', screens: ALL_SCREENS },
  { id: 'toggle-sidebar', key: 'Ctrl+\\', description: 'Toggle sidebar', screens: ['workflow'] },
  { id: 'toggle-diff', key: 'Ctrl+D', description: 'Toggle diff', screens: ['workflow'] },
  { key: '↑/↓', description: 'Scroll', screens: ['workflow'] },
  { key: 'Enter', description: 'Continue', screens: ['summary'] },
];

export function getShortcutKey(id: string): string | null {
  return SHORTCUTS.find(s => s.id === id)?.key ?? null;
}

export function getShortcutsForScreen(screen: Screen): ShortcutInfo[] {
  return SHORTCUTS.filter((s) => s.screens.includes(screen));
}
