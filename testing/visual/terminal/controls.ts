import type { IDisposable, Terminal } from '@xterm/headless';
import { sanitizeHyperlink, type Hyperlink } from '../contracts/hyperlinks.js';
import {
  ControlPolicyMetadataSchema,
  HyperlinkPolicyMetadataSchema,
} from '../contracts/manifest-fields.js';
import { CONTROL_POLICY_VERSION, HYPERLINK_POLICY_VERSION } from '../contracts/schema-versions.js';

const ESC = '\u001b';
const BEL = '\u0007';
const STRING_TERMINATOR = '\\';

export const MAX_CAPTURED_FRAME_CODE_UNITS = 1_048_576;

export const CONTROL_POLICY = ControlPolicyMetadataSchema.parse({
  version: CONTROL_POLICY_VERSION,
  ansi: 'retained-diagnostic',
  txt: 'removed',
  cells: 'interpreted',
  raster: 'removed',
});

export const HYPERLINK_POLICY = HyperlinkPolicyMetadataSchema.parse({
  version: HYPERLINK_POLICY_VERSION,
  ansi: 'sanitized',
  txt: 'removed',
  cells: 'sanitized-structured',
  raster: 'non-interactive',
  productionFiles: 'project-relative-only',
  externalUrls: 'public-http-https-only',
});

export const TERMINAL_CONTROL_DISPOSITIONS = Object.freeze([
  { control: 'csi', disposition: 'interpreted-isolated' },
  { control: 'osc', disposition: 'removed' },
  { control: 'osc-8', disposition: 'sanitized-structured' },
  { control: 'cursor', disposition: 'interpreted-isolated' },
  { control: 'alternate-buffer', disposition: 'interpreted-isolated' },
  { control: 'kitty-graphics', disposition: 'removed' },
  { control: 'kitty-keyboard', disposition: 'interpreted-isolated-no-input' },
  { control: 'mouse', disposition: 'mode-only-no-input' },
  { control: 'bracketed-paste', disposition: 'markers-only-no-input' },
  { control: 'dcs-apc-pm-sos', disposition: 'removed' },
] satisfies readonly {
  readonly control: string;
  readonly disposition: string;
}[]);

export interface SanitizeTerminalFrameOptions {
  readonly ansi: string;
  readonly projectRoot: string;
}

interface BufferPosition {
  readonly buffer: 'normal' | 'alternate';
  readonly column: number;
  readonly absoluteRow: number;
}

interface HyperlinkSpan {
  readonly start: BufferPosition;
  readonly end: BufferPosition;
  readonly hyperlink: Hyperlink;
}

export interface HyperlinkCapture {
  readonly hyperlinkAt: (options: {
    readonly buffer: 'normal' | 'alternate';
    readonly absoluteRow: number;
    readonly column: number;
  }) => Hyperlink | null;
  readonly finish: () => void;
  readonly dispose: () => void;
}

export function sanitizeTerminalFrame(options: SanitizeTerminalFrameOptions): string {
  const { ansi, projectRoot } = options;
  if (ansi.length > MAX_CAPTURED_FRAME_CODE_UNITS) {
    throw new Error(`Captured terminal frame exceeds ${MAX_CAPTURED_FRAME_CODE_UNITS} code units`);
  }

  let output = '';
  let offset = 0;
  while (offset < ansi.length) {
    const character = ansi[offset];
    if (character === ESC) {
      const parsed = consumeEscapedControl({ ansi, offset, projectRoot });
      output += parsed.output;
      offset = parsed.nextOffset;
      continue;
    }
    if (character === '\u009b') {
      const parsed = consumeCsi(ansi, offset + 1);
      output += parsed.complete ? `${ESC}[${parsed.payload}` : '';
      offset = parsed.nextOffset;
      continue;
    }
    if (character === '\u009d') {
      const parsed = consumeStringControl({ ansi, offset: offset + 1, allowBell: true });
      output += parsed.complete ? sanitizeOsc({ payload: parsed.payload, projectRoot }) : '';
      offset = parsed.nextOffset;
      continue;
    }
    if (
      character === '\u0090' ||
      character === '\u0098' ||
      character === '\u009e' ||
      character === '\u009f'
    ) {
      offset = consumeStringControl({ ansi, offset: offset + 1, allowBell: false }).nextOffset;
      continue;
    }
    if (isDiscardedControl(character)) {
      offset += 1;
      continue;
    }
    output += character;
    offset += 1;
  }
  return output;
}

export function captureTerminalHyperlinks(
  terminal: Terminal,
  projectRoot: string,
): HyperlinkCapture {
  const spans: HyperlinkSpan[] = [];
  let open: { readonly start: BufferPosition; readonly hyperlink: Hyperlink } | null = null;

  const handler: IDisposable = terminal.parser.registerOscHandler(8, (data) => {
    const separator = data.indexOf(';');
    const value = separator === -1 ? '' : data.slice(separator + 1);
    const position = getBufferPosition(terminal);
    if (open !== null) {
      spans.push({ start: open.start, end: position, hyperlink: open.hyperlink });
      open = null;
    }
    if (value.length > 0) {
      const hyperlink = sanitizeHyperlink({ value, projectRoot });
      if (hyperlink !== null) open = { start: position, hyperlink };
    }
    return false;
  });

  const finish = () => {
    if (open === null) return;
    spans.push({ start: open.start, end: getBufferPosition(terminal), hyperlink: open.hyperlink });
    open = null;
  };

  return {
    hyperlinkAt: ({ buffer, absoluteRow, column }) => {
      for (let index = spans.length - 1; index >= 0; index -= 1) {
        const span = spans[index];
        if (
          span?.start.buffer === buffer &&
          isAtOrAfter({ buffer, absoluteRow, column }, span.start) &&
          isBefore({ buffer, absoluteRow, column }, span.end)
        ) {
          return span.hyperlink;
        }
      }
      return null;
    },
    finish,
    dispose: () => handler.dispose(),
  };
}

function consumeEscapedControl(options: {
  readonly ansi: string;
  readonly offset: number;
  readonly projectRoot: string;
}): { readonly output: string; readonly nextOffset: number } {
  const { ansi, offset, projectRoot } = options;
  const introducer = ansi[offset + 1];
  if (introducer === undefined) return { output: '', nextOffset: ansi.length };
  if (introducer === ']') {
    const parsed = consumeStringControl({ ansi, offset: offset + 2, allowBell: true });
    return {
      output: parsed.complete ? sanitizeOsc({ payload: parsed.payload, projectRoot }) : '',
      nextOffset: parsed.nextOffset,
    };
  }
  if (introducer === 'P' || introducer === '_' || introducer === '^' || introducer === 'X') {
    return {
      output: '',
      nextOffset: consumeStringControl({ ansi, offset: offset + 2, allowBell: false }).nextOffset,
    };
  }
  if (introducer === '[') {
    const parsed = consumeCsi(ansi, offset + 2);
    return {
      output: parsed.complete ? `${ESC}[${parsed.payload}` : '',
      nextOffset: parsed.nextOffset,
    };
  }
  return { output: `${ESC}${introducer}`, nextOffset: offset + 2 };
}

function consumeCsi(
  ansi: string,
  offset: number,
): { readonly complete: boolean; readonly payload: string; readonly nextOffset: number } {
  for (let index = offset; index < ansi.length; index += 1) {
    const code = ansi.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) {
      return {
        complete: true,
        payload: ansi.slice(offset, index + 1),
        nextOffset: index + 1,
      };
    }
    if (code < 0x20 || code > 0x3f) {
      return { complete: false, payload: '', nextOffset: index + 1 };
    }
  }
  return { complete: false, payload: '', nextOffset: ansi.length };
}

function consumeStringControl(options: {
  readonly ansi: string;
  readonly offset: number;
  readonly allowBell: boolean;
}): { readonly complete: boolean; readonly payload: string; readonly nextOffset: number } {
  const { ansi, offset, allowBell } = options;
  for (let index = offset; index < ansi.length; index += 1) {
    const character = ansi[index];
    if ((allowBell && character === BEL) || character === '\u009c') {
      return {
        complete: true,
        payload: ansi.slice(offset, index),
        nextOffset: index + 1,
      };
    }
    if (character === ESC && ansi[index + 1] === STRING_TERMINATOR) {
      return {
        complete: true,
        payload: ansi.slice(offset, index),
        nextOffset: index + 2,
      };
    }
  }
  return { complete: false, payload: '', nextOffset: ansi.length };
}

function sanitizeOsc(options: { readonly payload: string; readonly projectRoot: string }): string {
  const { payload, projectRoot } = options;
  const identifierEnd = payload.indexOf(';');
  if (identifierEnd === -1 || payload.slice(0, identifierEnd) !== '8') return '';

  const valueSeparator = payload.indexOf(';', identifierEnd + 1);
  if (valueSeparator === -1) return '';
  const value = payload.slice(valueSeparator + 1);
  if (value.length === 0) return `${ESC}]8;;${ESC}${STRING_TERMINATOR}`;

  const hyperlink = sanitizeHyperlink({ value, projectRoot });
  if (hyperlink === null) return '';
  const safeValue = hyperlink.kind === 'external' ? hyperlink.url : value;
  return `${ESC}]8;;${safeValue}${ESC}${STRING_TERMINATOR}`;
}

function getBufferPosition(terminal: Terminal): BufferPosition {
  const buffer = terminal.buffer.active;
  return {
    buffer: buffer.type,
    column: buffer.cursorX,
    absoluteRow: buffer.baseY + buffer.cursorY,
  };
}

function isAtOrAfter(left: BufferPosition, right: BufferPosition): boolean {
  return (
    left.absoluteRow > right.absoluteRow ||
    (left.absoluteRow === right.absoluteRow && left.column >= right.column)
  );
}

function isBefore(left: BufferPosition, right: BufferPosition): boolean {
  return (
    left.absoluteRow < right.absoluteRow ||
    (left.absoluteRow === right.absoluteRow && left.column < right.column)
  );
}

function isDiscardedControl(character: string | undefined): boolean {
  if (character === undefined) return false;
  if (character === '\n' || character === '\r' || character === '\t' || character === '\b') {
    return false;
  }
  const code = character.charCodeAt(0);
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}
