import { ALL_SCREENS } from '../navigation/types.js';
import type { InputMode, Screen } from '../navigation/types.js';

interface ShortcutInfo {
  id: string;
  key: string;
  description: string;
  screens: readonly Screen[];
  inputModes?: readonly InputMode[] | undefined;
}

const SHORTCUTS: ShortcutInfo[] = [
  {
    id: 'exit',
    key: 'Ctrl+C',
    description: 'Interrupt, then exit (press again)',
    screens: ['workflow'],
  },
  {
    id: 'exit',
    key: 'Ctrl+C',
    description: 'Exit',
    screens: ['home', 'summary', 'setup'],
  },
  { id: 'command-palette', key: 'Ctrl+K', description: 'Command palette', screens: ALL_SCREENS },
  { id: 'help', key: 'Ctrl+/', description: 'Help', screens: ALL_SCREENS },
  { id: 'quit', key: 'Ctrl+Q', description: 'Quit', screens: ALL_SCREENS },
  {
    id: 'interrupt',
    key: 'Esc Esc',
    description: 'Interrupt current step (press again)',
    screens: ['workflow'],
  },
  {
    id: 'cancel',
    key: 'Esc Esc',
    description: 'Cancel workflow at a prompt (press again)',
    screens: ['workflow'],
  },
  {
    id: 'recent-sessions',
    key: 'Ctrl+R',
    description: 'Focus recent sessions',
    screens: ['home'],
  },
  { id: 'skills', key: 'Ctrl+S', description: 'Skills picker', screens: ['home'] },
  { id: 'settings', key: 'Ctrl+,', description: 'Settings', screens: ALL_SCREENS },
  { id: 'close-overlay', key: 'Escape', description: 'Close overlay', screens: ALL_SCREENS },
  {
    id: 'toggle-diff',
    key: 'Ctrl+D',
    description: 'Toggle diff; attached detaches',
    screens: ['workflow'],
  },
  {
    id: 'scroll',
    key: 'Shift+↑/↓, PgUp/PgDn, Home/End',
    description: 'Scroll; PageUp/PageDown; /scroll top|bottom',
    screens: ['workflow'],
  },
  {
    id: 'review-edit',
    key: 'Ctrl+E',
    description: 'Open editor in review mode only',
    screens: ['workflow'],
    inputModes: ['review'],
  },
  {
    id: 'activity',
    key: '/activity, Ctrl+A',
    description: 'Expand activity rows',
    screens: ['workflow'],
  },
  { id: 'continue', key: 'Enter', description: 'Continue', screens: ['summary'] },
];

export function getShortcutKey(id: string): string | null {
  return SHORTCUTS.find((s) => s.id === id)?.key ?? null;
}

export function getShortcutsForScreen(
  screen: Screen,
  opts: { inputMode?: InputMode | undefined } = {},
): ShortcutInfo[] {
  return SHORTCUTS.filter((shortcut) => {
    if (!shortcut.screens.includes(screen)) return false;
    if (shortcut.inputModes === undefined) return true;
    return opts.inputMode !== undefined && shortcut.inputModes.includes(opts.inputMode);
  });
}
