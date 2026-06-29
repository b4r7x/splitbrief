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
    description: 'interrupt, then exit (press again)',
    screens: ['workflow'],
  },
  {
    id: 'exit',
    key: 'Ctrl+C',
    description: 'exit',
    screens: ['home', 'summary', 'setup'],
  },
  { id: 'command-palette', key: 'Ctrl+K', description: 'command palette', screens: ALL_SCREENS },
  { id: 'help', key: 'Ctrl+/', description: 'help', screens: ALL_SCREENS },
  { id: 'quit', key: 'Ctrl+Q', description: 'quit', screens: ALL_SCREENS },
  {
    id: 'interrupt',
    key: 'Esc Esc',
    description: 'interrupt current step (press again)',
    screens: ['workflow'],
  },
  {
    id: 'cancel',
    key: 'Esc Esc',
    description: 'cancel workflow at a prompt (press again)',
    screens: ['workflow'],
  },
  {
    id: 'recent-sessions',
    key: 'Ctrl+R',
    description: 'focus recent sessions',
    screens: ['home'],
  },
  { id: 'skills', key: 'Ctrl+S', description: 'skills picker', screens: ['home'] },
  { id: 'settings', key: 'Ctrl+,', description: 'settings', screens: ALL_SCREENS },
  { id: 'close-overlay', key: 'Escape', description: 'close overlay', screens: ALL_SCREENS },
  {
    id: 'toggle-diff',
    key: 'Ctrl+D',
    description: 'toggle diff; attached detaches',
    screens: ['workflow'],
  },
  {
    id: 'scroll',
    key: 'Shift+↑/↓, PgUp/PgDn, Home/End',
    description: 'scroll; PageUp/PageDown; /scroll top|bottom',
    screens: ['workflow'],
  },
  {
    id: 'review-edit',
    key: 'Ctrl+E',
    description: 'open editor in review mode only',
    screens: ['workflow'],
    inputModes: ['review'],
  },
  {
    id: 'activity',
    key: '/activity, Ctrl+A',
    description: 'expand activity rows',
    screens: ['workflow'],
  },
  { id: 'continue', key: 'Enter', description: 'continue', screens: ['summary'] },
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
