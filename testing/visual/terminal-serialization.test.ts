import { describe, expect, it } from 'vitest';
import { FrameArtifactIdentitySchema, frameArtifactKey } from './contracts/artifact-identity.js';
import { CellGridSchema } from './contracts/cells.js';
import { viewport } from './contracts/geometry.js';
import { checkpointId, scenarioId } from './contracts/identifiers.js';
import { CELL_GRID_SCHEMA_VERSION } from './contracts/schema-versions.js';
import { ArtifactProvenanceSchema } from './contracts/selection.js';
import { CONTROL_POLICY, HYPERLINK_POLICY } from './terminal/controls.js';
import { parseTerminalFrame } from './terminal/parse.js';
import { serializeTerminalTruth } from './terminal/serialize/truth.js';

const ESC = '\u001b';

describe('terminal diagnostic serialization', () => {
  it('deterministically reconstructs control-free TXT from versioned cells JSON', async () => {
    const identity = createIdentity(3);
    const source = [
      `${ESC}[1;3;4;9;38;2;12;34;56;48;5;25mStyled${ESC}[0m  `,
      `\n${ESC}]8;;https://openai.com/docs${ESC}\\link${ESC}]8;;${ESC}\\界`,
      `\n`,
    ].join('');
    const grid = await parseTerminalFrame({ ansi: source, identity, projectRoot: process.cwd() });

    const first = serializeTerminalTruth(grid);
    const second = serializeTerminalTruth(grid);
    const cells = CellGridSchema.parse(JSON.parse(first.cellsJson));
    const reconstructed = `${cells.cells
      .map((row) => row.map((cell) => cell.grapheme).join(''))
      .join('\n')}\n`;

    expect(second).toEqual(first);
    expect(cells.schemaVersion).toBe(CELL_GRID_SCHEMA_VERSION);
    expect(cells).toEqual(grid);
    expect(reconstructed).toBe(first.txt);
    expect(first.txt.split('\n')).toEqual([
      'Styled              ',
      'link界              ',
      '                    ',
      '',
    ]);
    expect(first.cellsJson).not.toContain(ESC);
    expect(first.cellsJson).not.toContain('rawEvent');
  });

  it('retains style, RGB/indexed colors, and safe links in ANSI without leaking them to TXT', async () => {
    const identity = createIdentity(3);
    const source = [
      `${ESC}[1;3;4;9;38;2;12;34;56;48;5;25mS${ESC}[0m`,
      `${ESC}[38;5;196mI${ESC}[0m`,
      `${ESC}]8;;https://openai.com/docs${ESC}\\L${ESC}]8;;${ESC}\\`,
    ].join('');
    const grid = await parseTerminalFrame({ ansi: source, identity, projectRoot: process.cwd() });
    const serialized = serializeTerminalTruth(grid);
    const reparsed = await parseTerminalFrame({
      ansi: serialized.ansi,
      identity: createIdentity(4),
      projectRoot: process.cwd(),
    });

    expect(reparsed.cells.slice(0, grid.cells.length)).toEqual(grid.cells);
    expect(serialized.ansi).toContain(`${ESC}[`);
    expect(serialized.ansi).toContain('38;2;12;34;56');
    expect(serialized.ansi).toContain('48;5;25');
    expect(serialized.ansi).toContain('38;5;196');
    expect(serialized.ansi).toContain('https://openai.com/docs');
    expect(serialized.txt).not.toContain(ESC);
    expect(serialized.txt).not.toContain('https://openai.com/docs');
    expect(CONTROL_POLICY).toMatchObject({
      ansi: 'retained-diagnostic',
      txt: 'removed',
      cells: 'interpreted',
    });
    expect(HYPERLINK_POLICY).toMatchObject({
      ansi: 'sanitized',
      txt: 'removed',
      cells: 'sanitized-structured',
    });
  });
});

function createIdentity(rows: number) {
  const provenance = ArtifactProvenanceSchema.parse({
    scenarioId: scenarioId('serialization-fixture'),
    scenarioTitle: 'Serialization fixture',
    fixtureVersion: 1,
    checkpointId: checkpointId('ready'),
    viewport: viewport({ cols: 20, rows }),
  });
  return FrameArtifactIdentitySchema.parse({
    kind: 'frame',
    key: frameArtifactKey(provenance),
    provenance,
    elementId: null,
    parentFrameKey: null,
  });
}
