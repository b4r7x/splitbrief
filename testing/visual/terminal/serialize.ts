import {
  CellGridSchema,
  type Cell,
  type CellGrid,
  type CellStyle,
  type TerminalColor,
} from '../contracts/cells.js';
import type { ArtifactIdentity } from '../contracts/artifact-identity.js';
import type { Hyperlink } from '../contracts/hyperlinks.js';

const ESC = '\u001b';
const SGR_RESET = `${ESC}[0m`;
const OSC_8_CLOSE = `${ESC}]8;;${ESC}\\`;

export const SERIALIZED_LINE_ENDING = '\n';

const DEFAULT_COLOR: TerminalColor = { kind: 'default' };
const DEFAULT_STYLE: CellStyle = {
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  blink: false,
  inverse: false,
  invisible: false,
  strikethrough: false,
};

interface AnsiState {
  readonly foreground: TerminalColor;
  readonly background: TerminalColor;
  readonly style: CellStyle;
  readonly hyperlink: Hyperlink | null;
}

export interface SerializedTerminalTruth {
  readonly ansi: string;
  readonly txt: string;
  readonly cellsJson: string;
}

export function serializeTxt(grid: CellGrid): string {
  return txtFromGrid(CellGridSchema.parse(grid));
}

export function serializeTerminalTruth(grid: CellGrid): SerializedTerminalTruth {
  const validated = CellGridSchema.parse(grid);
  return {
    ansi: ansiFromGrid(validated),
    txt: txtFromGrid(validated),
    cellsJson: cellsJsonFromGrid(validated),
  };
}

function txtFromGrid(grid: CellGrid): string {
  const text = `${grid.cells.map(textFromRow).join(SERIALIZED_LINE_ENDING)}${SERIALIZED_LINE_ENDING}`;
  if (hasUnsafeTxtControl(text)) {
    throw new Error('TXT serialization produced a terminal control byte');
  }
  return text;
}

function hasUnsafeTxtControl(text: string): boolean {
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code <= 0x09 || (code >= 0x0b && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function textFromRow(row: readonly Cell[]): string {
  return row.map((cell) => cell.grapheme).join('');
}

function ansiFromGrid(grid: CellGrid): string {
  const output: string[] = [];
  let state = defaultAnsiState();

  for (const [rowIndex, row] of grid.cells.entries()) {
    for (const cell of row) {
      if (cell.continuation) continue;
      const transition = ansiTransition(state, cell);
      output.push(transition.sequence, cell.grapheme);
      state = transition.state;
    }

    if (state.hyperlink !== null) {
      output.push(OSC_8_CLOSE);
      state = { ...state, hyperlink: null };
    }
    if (rowIndex === grid.cells.length - 1 && !isDefaultAnsiState(state)) {
      output.push(SGR_RESET);
      state = defaultAnsiState();
    }
    output.push(SERIALIZED_LINE_ENDING);
  }

  return output.join('');
}

function defaultAnsiState(): AnsiState {
  return {
    foreground: DEFAULT_COLOR,
    background: DEFAULT_COLOR,
    style: DEFAULT_STYLE,
    hyperlink: null,
  };
}

function ansiTransition(
  state: AnsiState,
  cell: Cell,
): { readonly sequence: string; readonly state: AnsiState } {
  const sequence: string[] = [];
  if (!hasSameHyperlink(state.hyperlink, cell.hyperlink)) {
    if (state.hyperlink !== null) sequence.push(OSC_8_CLOSE);
    if (cell.hyperlink !== null) sequence.push(openHyperlink(cell.hyperlink));
  }

  const sgr = sgrTransition(state, cell);
  if (sgr.length > 0) sequence.push(`${ESC}[${sgr.join(';')}m`);
  return {
    sequence: sequence.join(''),
    state: {
      foreground: cell.foreground,
      background: cell.background,
      style: cell.style,
      hyperlink: cell.hyperlink,
    },
  };
}

function sgrTransition(state: AnsiState, cell: Cell): number[] {
  const codes = styleTransition(state.style, cell.style);
  if (!hasSameColor(state.foreground, cell.foreground)) {
    codes.push(...foregroundCodes(cell.foreground));
  }
  if (!hasSameColor(state.background, cell.background)) {
    codes.push(...backgroundCodes(cell.background));
  }
  return codes;
}

function styleTransition(current: CellStyle, next: CellStyle): number[] {
  const codes: number[] = [];
  const resetsIntensity = (current.bold && !next.bold) || (current.dim && !next.dim);
  if (resetsIntensity) {
    codes.push(22);
    if (next.bold) codes.push(1);
    if (next.dim) codes.push(2);
  } else {
    if (!current.bold && next.bold) codes.push(1);
    if (!current.dim && next.dim) codes.push(2);
  }
  pushAttributeTransition(codes, current.italic, next.italic, 3, 23);
  pushAttributeTransition(codes, current.underline, next.underline, 4, 24);
  pushAttributeTransition(codes, current.blink, next.blink, 5, 25);
  pushAttributeTransition(codes, current.inverse, next.inverse, 7, 27);
  pushAttributeTransition(codes, current.invisible, next.invisible, 8, 28);
  pushAttributeTransition(codes, current.strikethrough, next.strikethrough, 9, 29);
  return codes;
}

function pushAttributeTransition(
  codes: number[],
  current: boolean,
  next: boolean,
  enable: number,
  disable: number,
): void {
  if (current === next) return;
  codes.push(next ? enable : disable);
}

function foregroundCodes(color: TerminalColor): number[] {
  switch (color.kind) {
    case 'default':
      return [39];
    case 'indexed':
      return indexedColorCodes(color.index, 30, 90, 38);
    case 'rgb':
      return [38, 2, color.red, color.green, color.blue];
    default: {
      const unhandled: never = color;
      return unhandled;
    }
  }
}

function backgroundCodes(color: TerminalColor): number[] {
  switch (color.kind) {
    case 'default':
      return [49];
    case 'indexed':
      return indexedColorCodes(color.index, 40, 100, 48);
    case 'rgb':
      return [48, 2, color.red, color.green, color.blue];
    default: {
      const unhandled: never = color;
      return unhandled;
    }
  }
}

function indexedColorCodes(
  index: number,
  standardBase: number,
  brightBase: number,
  extendedPrefix: number,
): number[] {
  if (index < 8) return [standardBase + index];
  if (index < 16) return [brightBase + index - 8];
  return [extendedPrefix, 5, index];
}

function hasSameColor(left: TerminalColor, right: TerminalColor): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case 'default':
      return right.kind === 'default';
    case 'indexed':
      return right.kind === 'indexed' && left.index === right.index;
    case 'rgb':
      return (
        right.kind === 'rgb' &&
        left.red === right.red &&
        left.green === right.green &&
        left.blue === right.blue
      );
    default: {
      const unhandled: never = left;
      return unhandled;
    }
  }
}

function hasSameHyperlink(left: Hyperlink | null, right: Hyperlink | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case 'external':
      return right.kind === 'external' && left.url === right.url;
    case 'project-file':
      return right.kind === 'project-file' && left.path === right.path;
    default: {
      const unhandled: never = left;
      return unhandled;
    }
  }
}

function openHyperlink(hyperlink: Hyperlink): string {
  const target =
    hyperlink.kind === 'external'
      ? hyperlink.url
      : `file:./${hyperlink.path.split('/').map(encodeURIComponent).join('/')}`;
  return `${ESC}]8;;${target}${ESC}\\`;
}

function isDefaultAnsiState(state: AnsiState): boolean {
  return (
    state.hyperlink === null &&
    hasSameColor(state.foreground, DEFAULT_COLOR) &&
    hasSameColor(state.background, DEFAULT_COLOR) &&
    hasSameStyle(state.style, DEFAULT_STYLE)
  );
}

function hasSameStyle(left: CellStyle, right: CellStyle): boolean {
  return (
    left.bold === right.bold &&
    left.dim === right.dim &&
    left.italic === right.italic &&
    left.underline === right.underline &&
    left.blink === right.blink &&
    left.inverse === right.inverse &&
    left.invisible === right.invisible &&
    left.strikethrough === right.strikethrough
  );
}

function cellsJsonFromGrid(grid: CellGrid): string {
  const serialized = {
    schemaVersion: grid.schemaVersion,
    identity: identityForJson(grid.identity),
    rect: {
      x: grid.rect.x,
      y: grid.rect.y,
      width: grid.rect.width,
      height: grid.rect.height,
    },
    cells: grid.cells.map((row) => row.map(cellForJson)),
  };
  return `${JSON.stringify(serialized, null, 2)}${SERIALIZED_LINE_ENDING}`;
}

function identityForJson(identity: ArtifactIdentity) {
  const base = {
    kind: identity.kind,
    key: identity.key,
    provenance: {
      scenarioId: identity.provenance.scenarioId,
      scenarioTitle: identity.provenance.scenarioTitle,
      fixtureVersion: identity.provenance.fixtureVersion,
      checkpointId: identity.provenance.checkpointId,
      viewport: {
        cols: identity.provenance.viewport.cols,
        rows: identity.provenance.viewport.rows,
      },
    },
  };
  switch (identity.kind) {
    case 'frame':
      return {
        ...base,
        elementId: null,
        parentFrameKey: null,
      };
    case 'crop':
      return {
        ...base,
        elementId: identity.elementId,
        parentFrameKey: identity.parentFrameKey,
      };
    default: {
      const unhandled: never = identity;
      return unhandled;
    }
  }
}

function cellForJson(cell: Cell) {
  return {
    grapheme: cell.grapheme,
    width: cell.width,
    continuation: cell.continuation,
    foreground: colorForJson(cell.foreground),
    background: colorForJson(cell.background),
    style: {
      bold: cell.style.bold,
      dim: cell.style.dim,
      italic: cell.style.italic,
      underline: cell.style.underline,
      blink: cell.style.blink,
      inverse: cell.style.inverse,
      invisible: cell.style.invisible,
      strikethrough: cell.style.strikethrough,
    },
    hyperlink: cell.hyperlink === null ? null : hyperlinkForJson(cell.hyperlink),
  };
}

function colorForJson(color: TerminalColor) {
  switch (color.kind) {
    case 'default':
      return { kind: color.kind };
    case 'indexed':
      return { kind: color.kind, index: color.index };
    case 'rgb':
      return { kind: color.kind, red: color.red, green: color.green, blue: color.blue };
    default: {
      const unhandled: never = color;
      return unhandled;
    }
  }
}

function hyperlinkForJson(hyperlink: Hyperlink) {
  switch (hyperlink.kind) {
    case 'external':
      return { kind: hyperlink.kind, url: hyperlink.url };
    case 'project-file':
      return { kind: hyperlink.kind, path: hyperlink.path };
    default: {
      const unhandled: never = hyperlink;
      return unhandled;
    }
  }
}
