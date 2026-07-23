import type { Cell, CellGrid, TerminalColor } from '../../contracts/cells.js';
import type { ArtifactIdentity } from '../../contracts/artifact-identity.js';
import type { Hyperlink } from '../../contracts/hyperlinks.js';
import { SERIALIZED_LINE_ENDING } from './text.js';

export function cellsJsonFromGrid(grid: CellGrid): string {
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
