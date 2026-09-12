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
    key: 'ctrl+c',
    description: 'Interrupt, then exit (press again)',
    screens: ['workflow'],
  },
  {
    id: 'exit',
    key: 'ctrl+c',
    description: 'Exit',
    screens: ['home', 'summary', 'setup'],
  },
  { id: 'command-palette', key: 'ctrl+k', description: 'Command palette', screens: ALL_SCREENS },
  { id: 'help', key: 'ctrl+/', description: 'Help', screens: ALL_SCREENS },
  { id: 'quit', key: 'ctrl+q', description: 'Quit', screens: ALL_SCREENS },
  {
    id: 'interrupt',
    key: 'esc esc',
    description: 'Interrupt current step (press again)',
    screens: ['workflow'],
  },
  {
    id: 'cancel',
    key: 'esc esc',
    description: 'Cancel workflow at a prompt (press again)',
    screens: ['workflow'],
  },
  {
    id: 'recent-sessions',
    key: 'ctrl+r',
    description: 'Focus recent sessions',
    screens: ['home'],
  },
  { id: 'skills', key: 'ctrl+s', description: 'Skills picker', screens: ['home'] },
  { id: 'settings', key: 'ctrl+,', description: 'Settings', screens: ALL_SCREENS },
  { id: 'close-overlay', key: 'esc', description: 'Close overlay', screens: ALL_SCREENS },
  { id: 'toggle-diff', key: 'ctrl+d', description: 'Toggle diff', screens: ['workflow'] },
  {
    id: 'cost-drilldown',
    key: 'ctrl+g',
    description: 'Cost drilldown',
    screens: ['workflow'],
  },
  {
    id: 'scroll',
    key: 'shift+↑/↓, pgup/pgdn, home/end',
    description: 'Scroll; PageUp/PageDown; /scroll top|bottom',
    screens: ['workflow'],
  },
  {
    id: 'review-edit',
    key: 'ctrl+e',
    description: 'Open editor in review mode only',
    screens: ['workflow'],
    inputModes: ['review'],
  },
  {
    id: 'activity',
    key: '/activity, ctrl+a',
    description: 'Expand activity rows',
    screens: ['workflow'],
  },
  { id: 'continue', key: 'enter', description: 'Continue', screens: ['summary'] },
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
