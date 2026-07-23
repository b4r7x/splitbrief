export type MouseEventType = 'wheel-up' | 'wheel-down' | 'press' | 'release' | 'move';

export interface MouseEvent {
  type: MouseEventType;
  x: number;
  y: number;
  button: number;
  shift: boolean;
  meta: boolean;
  ctrl: boolean;
}

export type MouseListener = (event: MouseEvent) => void;

export type EscapeDecision =
  | { kind: 'hold' }
  | { kind: 'paste-start'; length: number }
  | { kind: 'paste-end'; length: number }
  | { kind: 'mouse'; length: number; event: MouseEvent | undefined }
  | { kind: 'skip'; length: number }
  | { kind: 'paste-newline'; length: number }
  | { kind: 'text'; length: number };

export interface FilteredStdin {
  stdin: NodeJS.ReadStream;
  activate: () => void;
  onMouse: (listener: MouseListener) => () => void;
  isPasteActive: () => boolean;
  disable: () => void;
}
