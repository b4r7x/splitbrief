import type { Key } from 'ink';
import type { InputMode } from '../../core/navigation/types.js';
import { isTextEntryInput } from '../../lib/terminal/text-entry.js';

export const COMMANDS_ONLY_NOTICE = 'Only /commands here';

export interface ComposerKeyState {
  mode: InputMode;
  hasSendNow: boolean;
  /** The run is live or parked, so a send now reaches it. */
  runActive: boolean;
  hasTab: boolean;
  completionOpen: boolean;
  commandsOnly: boolean;
  draftEmpty: boolean;
}

/** What a key does before the input reads it; only `input` lets the input have it. */
type ComposerKeyAction = 'send-now' | 'tab' | 'paste-image' | 'commands-only' | 'input';

export function gateComposerKey(
  input: string,
  key: Key,
  state: ComposerKeyState,
): ComposerKeyAction {
  if (key.return && key.ctrl && state.hasSendNow && state.mode === 'normal' && state.runActive) {
    return 'send-now';
  }
  // An open list owns Tab: it completes the row, and focus stays in the box.
  if (state.hasTab && !state.completionOpen && (key.tab || (key.shift && key.tab))) return 'tab';
  if (key.ctrl && input === 'v') return 'paste-image';
  // Only the first character of a draft decides this: once a line is under way the keys are text
  // again, so editing a command never has to pass the gate a second time.
  if (!state.commandsOnly || !state.draftEmpty) return 'input';
  if (!isTextEntryInput(input, key) || input.startsWith('/')) return 'input';
  return 'commands-only';
}
