import { describe, expect, it, vi } from 'vitest';
import { FrameArtifactIdentitySchema, frameArtifactKey } from './contracts/artifact-identity.js';
import type { Cell } from './contracts/cells.js';
import { viewport } from './contracts/geometry.js';
import { checkpointId, scenarioId } from './contracts/identifiers.js';
import { ArtifactProvenanceSchema } from './contracts/selection.js';
import { TERMINAL_CONTROL_DISPOSITIONS } from './terminal/controls.js';
import { parseTerminalFrame } from './terminal/parse.js';
import { serializeTxt } from './terminal/serialize.js';

const ESC = '\u001b';

describe('terminal cell parsing', () => {
  it('projects styles, colors, wide and combined graphemes, links, cursor state, and blanks', async () => {
    const identity = createIdentity(16, 5);
    const ansi = [
      `${ESC}[2J${ESC}[1;1H`,
      `${ESC}[1;3;4;9;38;2;12;34;56;48;5;25mS${ESC}[0m`,
      `${ESC}[1;3H${ESC}[38;5;196mI${ESC}[0m`,
      `${ESC}[1;5H界e\u0301`,
      `${ESC}[2;1Htail  `,
      `${ESC}[3;1H${ESC}]8;;https://openai.com/docs${ESC}\\link${ESC}]8;;${ESC}\\`,
      `${ESC}[4;1Hold${ESC}[4;1Hnew`,
      `${ESC}[?1049h${ESC}[1;1HALTERNATE${ESC}[?1049l`,
    ].join('');
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      const grid = await parseTerminalFrame({ ansi, identity, projectRoot: process.cwd() });

      expect(writeSpy).not.toHaveBeenCalled();
      expect(grid.rect).toEqual({ x: 0, y: 0, width: 16, height: 5 });
      expect(grid.cells).toHaveLength(5);
      expect(grid.cells.every((row) => row.length === 16)).toBe(true);

      const styled = requireCell(grid.cells[0], 0);
      expect(styled).toMatchObject({
        grapheme: 'S',
        width: 1,
        continuation: false,
        foreground: { kind: 'rgb', red: 12, green: 34, blue: 56 },
        background: { kind: 'indexed', index: 25 },
        style: {
          bold: true,
          dim: false,
          italic: true,
          underline: true,
          blink: false,
          inverse: false,
          invisible: false,
          strikethrough: true,
        },
      });
      expect(requireCell(grid.cells[0], 2).foreground).toEqual({ kind: 'indexed', index: 196 });
      expect(requireCell(grid.cells[0], 4)).toMatchObject({
        grapheme: '界',
        width: 2,
        continuation: false,
      });
      expect(requireCell(grid.cells[0], 5)).toMatchObject({
        grapheme: '',
        width: 0,
        continuation: true,
      });
      expect(requireCell(grid.cells[0], 6)).toMatchObject({
        grapheme: 'e\u0301',
        width: 1,
        continuation: false,
      });
      expect(textFromRow(grid.cells[1])).toBe('tail            ');
      expect(requireCell(grid.cells[2], 0).hyperlink).toEqual({
        kind: 'external',
        url: 'https://openai.com/docs',
      });
      expect(textFromRow(grid.cells[3])).toBe('new             ');
      expect(textFromRow(grid.cells[4])).toBe('                ');
      expect(serializeTxt(grid)).not.toContain('ALTERNATE');
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('isolates cursor and terminal modes while removing unsafe string controls', async () => {
    const identity = createIdentity(24, 3);
    const controls = [
      `${ESC}[2J${ESC}[1;1Hsafe`,
      `${ESC}]0;discarded title\u0007`,
      `${ESC}]52;c;ZGlzY2FyZGVk\u0007`,
      `${ESC}Pqdiscarded${ESC}\\`,
      `${ESC}_Gf=100;discarded${ESC}\\`,
      `${ESC}^discarded${ESC}\\`,
      `${ESC}Xdiscarded${ESC}\\`,
      `${ESC}[?1000h${ESC}[?1000l`,
      `${ESC}[?2004h${ESC}[200~${ESC}[201~${ESC}[?2004l`,
      `${ESC}[>1u${ESC}[<u`,
      `${ESC}[2;1Hcursor${ESC}[1D!`,
    ].join('');
    const grid = await parseTerminalFrame({
      ansi: controls,
      identity,
      projectRoot: process.cwd(),
    });
    const txt = serializeTxt(grid);

    expect(txt).toContain('safe');
    expect(txt).toContain('curso!');
    expect(txt).not.toContain('discarded');
    expect(txt).not.toContain('ZGlzY2FyZGVk');
    expect(txt).not.toContain(ESC);
    expect(txt).not.toContain('\u009b');
    expect(txt).not.toContain('\u009d');
    expect(TERMINAL_CONTROL_DISPOSITIONS.map(({ control }) => control)).toEqual([
      'csi',
      'osc',
      'osc-8',
      'cursor',
      'alternate-buffer',
      'kitty-graphics',
      'kitty-keyboard',
      'mouse',
      'bracketed-paste',
      'dcs-apc-pm-sos',
    ]);
  });
});

function createIdentity(cols: number, rows: number) {
  const provenance = ArtifactProvenanceSchema.parse({
    scenarioId: scenarioId('terminal-fixture'),
    scenarioTitle: 'Terminal fixture',
    fixtureVersion: 1,
    checkpointId: checkpointId('ready'),
    viewport: viewport({ cols, rows }),
  });
  return FrameArtifactIdentitySchema.parse({
    kind: 'frame',
    key: frameArtifactKey(provenance),
    provenance,
    elementId: null,
    parentFrameKey: null,
  });
}

function textFromRow(row: readonly Cell[] | undefined): string {
  if (row === undefined) throw new Error('Missing terminal row');
  return row.map((cell) => cell.grapheme).join('');
}

function requireCell(row: readonly Cell[] | undefined, index: number): Cell {
  const cell = row?.[index];
  if (cell === undefined) throw new Error(`Missing terminal cell at column ${index}`);
  return cell;
}
