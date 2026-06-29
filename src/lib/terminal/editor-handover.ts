import {
  kittyPushSequence,
  setTerminalInputModes,
  terminalSequences,
  writeTerminalSequence,
} from './control.js';
import { detectKittyKeyboardFlags, resolveKittyFlagBits } from './kitty-keyboard.js';

type HandoverSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGTSTP' | 'SIGCONT';

interface TerminalHandoverStdin {
  isRaw?: boolean | undefined;
  pause: () => unknown;
  resume: () => unknown;
  setRawMode?: ((mode: boolean) => unknown) | undefined;
}

export interface TerminalHandoverConfig {
  fullscreen: boolean;
  mouse: boolean;
  paste?: boolean | undefined;
  hover?: boolean | undefined;
  sourceStdin: TerminalHandoverStdin;
}

interface SignalSnapshot {
  signal: HandoverSignal;
  listeners: NodeJS.SignalsListener[];
  mask?: NodeJS.SignalsListener | undefined;
}

interface HandoverSnapshot {
  stdin: TerminalHandoverStdin;
  wasRaw: boolean;
  signals: SignalSnapshot[];
}

const HANDOVER_SIGNALS: readonly HandoverSignal[] = [
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
  'SIGTSTP',
  'SIGCONT',
];

let activeHandover: TerminalHandoverConfig | undefined;
const handoverSnapshots: HandoverSnapshot[] = [];

export function setActiveTerminalHandover(config: TerminalHandoverConfig | undefined): void {
  activeHandover = config;
}

function shouldMaskSignal(signal: HandoverSignal): boolean {
  return signal === 'SIGINT' || signal === 'SIGTERM' || signal === 'SIGHUP';
}

function maskSignalHandlers(): SignalSnapshot[] {
  return HANDOVER_SIGNALS.map((signal) => {
    const listeners = process.listeners(signal);
    for (const listener of listeners) process.off(signal, listener);

    if (!shouldMaskSignal(signal)) return { signal, listeners };

    const mask: NodeJS.SignalsListener = () => {};
    process.on(signal, mask);
    return { signal, listeners, mask };
  });
}

function restoreSignalHandlers(signals: SignalSnapshot[]): void {
  for (const snapshot of signals) {
    if (snapshot.mask) process.off(snapshot.signal, snapshot.mask);
    for (const listener of snapshot.listeners) process.on(snapshot.signal, listener);
  }
}

function setRawMode(stdin: TerminalHandoverStdin, mode: boolean): void {
  if (!stdin.setRawMode) return;
  try {
    stdin.setRawMode(mode);
  } catch {
    // The terminal may detach while handing stdio to a child process.
  }
}

function beginHandover(stdin: TerminalHandoverStdin): void {
  const snapshot: HandoverSnapshot = {
    stdin,
    wasRaw: stdin.isRaw === true,
    signals: maskSignalHandlers(),
  };
  handoverSnapshots.push(snapshot);
  if (snapshot.wasRaw) setRawMode(stdin, false);
}

function endHandover(): HandoverSnapshot | undefined {
  const snapshot = handoverSnapshots.pop();
  if (!snapshot) return undefined;
  if (snapshot.wasRaw) setRawMode(snapshot.stdin, true);
  restoreSignalHandlers(snapshot.signals);
  return snapshot;
}

export function suspendTerminalForEditor(config?: TerminalHandoverConfig): void {
  const handover = config ?? activeHandover;
  const stdin = handover?.sourceStdin ?? process.stdin;
  beginHandover(stdin);
  try {
    stdin.pause();
    if (!handover) return;
    const paste = handover.paste ?? handover.mouse;
    if (handover.mouse || paste) setTerminalInputModes('disable', { mouse: handover.mouse, paste });
    if (handover.fullscreen) {
      writeTerminalSequence(terminalSequences.popKittyKeyboard);
      writeTerminalSequence(terminalSequences.exitAltBuffer);
      writeTerminalSequence(terminalSequences.showCursor);
    }
  } catch (err) {
    const snapshot = endHandover();
    try {
      (snapshot?.stdin ?? stdin).resume();
    } catch {
      // The original suspend failure is the error callers need.
    }
    throw err;
  }
}

export function resumeTerminalAfterEditor(config?: TerminalHandoverConfig): void {
  const handover = config ?? activeHandover;
  try {
    if (handover) {
      if (handover.fullscreen) {
        writeTerminalSequence(terminalSequences.enterAltBuffer);
        writeTerminalSequence(terminalSequences.hideCursor);
        writeTerminalSequence(
          kittyPushSequence(resolveKittyFlagBits(detectKittyKeyboardFlags().flags)),
        );
        process.stdout.emit('resize');
      }
      const paste = handover.paste ?? handover.mouse;
      if (handover.mouse || paste)
        setTerminalInputModes('enable', { mouse: handover.mouse, paste, hover: handover.hover });
    }
  } finally {
    const snapshot = endHandover();
    (snapshot?.stdin ?? handover?.sourceStdin ?? process.stdin).resume();
  }
}
