import {
  kittyPushSequence,
  setTerminalInputModes,
  terminalSequences,
  writeTerminalSequence,
} from './control.js';
import { detectKittyKeyboardFlags, resolveKittyFlagBits } from './kitty-keyboard.js';

export interface TerminalHandoverConfig {
  fullscreen: boolean;
  mouse: boolean;
  sourceStdin: NodeJS.ReadStream;
}

let activeHandover: TerminalHandoverConfig | undefined;

export function setActiveTerminalHandover(config: TerminalHandoverConfig | undefined): void {
  activeHandover = config;
}

export function suspendTerminalForEditor(config?: TerminalHandoverConfig): void {
  const handover = config ?? activeHandover;
  (handover?.sourceStdin ?? process.stdin).pause();
  if (!handover) return;
  if (handover.mouse) setTerminalInputModes('disable');
  if (handover.fullscreen) {
    writeTerminalSequence(terminalSequences.popKittyKeyboard);
    writeTerminalSequence(terminalSequences.exitAltBuffer);
    writeTerminalSequence(terminalSequences.showCursor);
  }
}

export function resumeTerminalAfterEditor(config?: TerminalHandoverConfig): void {
  const handover = config ?? activeHandover;
  if (handover) {
    if (handover.fullscreen) {
      writeTerminalSequence(terminalSequences.enterAltBuffer);
      writeTerminalSequence(terminalSequences.hideCursor);
      writeTerminalSequence(
        kittyPushSequence(resolveKittyFlagBits(detectKittyKeyboardFlags().flags)),
      );
      process.stdout.emit('resize');
    }
    if (handover.mouse) setTerminalInputModes('enable');
  }
  (handover?.sourceStdin ?? process.stdin).resume();
}
