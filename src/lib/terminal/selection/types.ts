import type { Terminal } from '@xterm/headless';
import type { CopyOutcome } from '../../clipboard/clipboard.js';
import type { SelectionPoint, TerminalFrame } from './frame.js';

export interface SelectionGesture {
  phase: 'pressed' | 'dragging' | 'selected';
  anchor: SelectionPoint;
  focus: SelectionPoint;
  frame: Promise<TerminalFrame | undefined>;
  painted?: { anchor: SelectionPoint; focus: SelectionPoint };
}

export interface SelectionState {
  stdout: NodeJS.WriteStream;
  terminal: Terminal;
  writeOriginal: NodeJS.WriteStream['write'];
  copy: (text: string) => Promise<CopyOutcome>;
  reportError: (message: string) => void;
  onCopyKey: ((result: Promise<CopyOutcome | undefined>) => void) | undefined;
  gesture: SelectionGesture | undefined;
  disposed: boolean;
  suspended: boolean;
  repainting: boolean;
  writeRevision: number;
  lifecycleRevision: number;
  parsedAlternateExit: boolean;
  copyQueue: Promise<void>;
  pendingOutput: {
    data: Buffer;
    callback: ((error?: Error | null) => void) | undefined;
  }[];
}
