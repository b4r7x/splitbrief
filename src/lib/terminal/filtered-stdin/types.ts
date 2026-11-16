import type { StringDecoder } from 'node:string_decoder';

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

/**
 * What a mouse event does, run at its turn behind the input read before it. A wheel step returns
 * `true` when it only wrote a store: the wheel step behind it then runs in the same turn.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: a press or a move returns nothing.
export type MouseAction = () => boolean | void;

/**
 * Runs when the bridge reads the event, so it sees the frame on screen; the action it returns
 * runs at the event's turn.
 */
export type MouseListener = (event: MouseEvent) => MouseAction | undefined;

/** Hands a mouse event on to the mouse listeners. */
export type MouseDispatch = (event: MouseEvent) => void;

export type EscapeDecision =
  | { kind: 'hold' }
  | { kind: 'paste-start'; length: number }
  | { kind: 'paste-end'; length: number }
  | { kind: 'mouse'; length: number; event: MouseEvent | undefined }
  | { kind: 'skip'; length: number }
  | { kind: 'paste-newline'; length: number }
  | { kind: 'text'; length: number };

export interface PasteState {
  active: boolean;
  chunks: Buffer[];
  pendingCr: boolean;
}

export interface HeldPrefix {
  bytes: Buffer;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Runs after each key, paste or mouse action, or row of wheel steps, that the bridge gives on; the
 * next one waits until `release` runs.
 */
export type InputHold = (release: () => void) => void;

/** One key, paste, wheel step or other mouse action, in the order of its bytes. */
export type InputEntry =
  | { kind: 'key'; text: string }
  | { kind: 'paste'; text: string }
  | { kind: 'mouse'; actions: MouseAction[] }
  | { kind: 'wheel'; actions: MouseAction[] };

export interface FilteredStdinOptions {
  activate?: boolean | undefined;
  mouse?: boolean | undefined;
  hover?: boolean | undefined;
  paste?: boolean | undefined;
  handleMouse?: ((event: MouseEvent, dispatch: MouseDispatch) => void) | undefined;
  filterInput?: ((text: string) => string) | undefined;
  onPaste?: (() => void) | undefined;
}

export interface FilterState {
  filtered: NodeJS.ReadStream;
  decoder: StringDecoder;
  options: FilteredStdinOptions | undefined;
  mouseEnabled: boolean;
  mouseListeners: MouseListener[];
  held: HeldPrefix;
  paste: PasteState;
  active: boolean;
  disabled: boolean;
  queue: InputEntry[];
  hold: InputHold | null;
  waiting: boolean;
  delivering: boolean;
}

export interface FilteredStdin {
  stdin: NodeJS.ReadStream;
  activate: () => void;
  onMouse: (listener: MouseListener) => () => void;
  isPasteActive: () => boolean;
  /** Gives Ink one input at a time: the next one waits until `hold` releases the one before it. */
  holdInput: (hold: InputHold) => () => void;
  disable: () => void;
}
