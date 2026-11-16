import {
  isConfiguredKeyDebugEnabled,
  logSplitbriefRawKeyChunk,
} from '../../core/keybindings/debug-log.js';
import { copyToClipboard } from '../../lib/clipboard/copy.js';
import { setActiveFilteredStdin } from '../../lib/terminal/filtered-stdin/active.js';
import { createFilteredStdin } from '../../lib/terminal/filtered-stdin/create.js';
import { installTerminalSelection } from '../../lib/terminal/selection/install.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import type { TuiInput } from './types.js';

export function openTuiInput(fullscreen: boolean, modes: TuiInput['modes']): TuiInput {
  const selection =
    fullscreen && modes.useMouse && process.stdout.isTTY
      ? installTerminalSelection({
          stdout: process.stdout,
          copy: copyToClipboard,
          reportError: (message) => feedbackStore.setError(message),
          onCopyKey: (result) => {
            input.stdin.stdin.emit('selection-copy', result);
          },
        })
      : undefined;

  const rawKeyTap = isConfiguredKeyDebugEnabled()
    ? (chunk: Buffer) => logSplitbriefRawKeyChunk(chunk)
    : undefined;
  if (rawKeyTap) {
    process.stdin.on('data', rawKeyTap);
  }

  const input: TuiInput = {
    modes,
    selection,
    rawKeyTap,
    // Ink reads its keys through this stream in both render modes: it writes each backspace byte
    // as its own key, which Ink would otherwise join with the rest of the read.
    stdin: createFilteredStdin(process.stdin, {
      activate: false,
      mouse: modes.useMouse,
      hover: modes.useHover,
      handleMouse: selection?.handleMouse,
      filterInput: selection?.filterInput,
      onPaste: selection?.clear,
    }),
  };
  return input;
}

export function disableTuiInput(input: TuiInput): void {
  input.selection?.dispose();
  input.stdin.disable();
}

export function closeTuiInput(input: TuiInput): void {
  setActiveFilteredStdin(undefined);
  disableTuiInput(input);
  if (input.rawKeyTap) process.stdin.off('data', input.rawKeyTap);
}
