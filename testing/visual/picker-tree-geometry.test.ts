import { afterEach, describe, expect, it } from 'vitest';
import { glyph } from '../../src/lib/glyphs.js';
import { findVisualScenario } from './catalog.js';
import type { Cell } from './contracts/cells.js';
import { viewport, type Viewport } from './contracts/geometry.js';
import { ArtifactProvenanceSchema } from './contracts/selection.js';
import { teardownVisualFixture } from './fixtures/screen-fixtures.js';
import { mountGalleryScenario } from './gallery/mount.js';
import { parseTerminalFrame } from './terminal/parse.js';
import { createFrameIdentity } from './visual-contract-fixtures.js';

interface GeometryCase {
  readonly viewport: Viewport;
}

const SCENARIO_ID = 'overlay-picker-opencode-expanded';

const CASES: readonly GeometryCase[] = [
  { viewport: viewport({ cols: 120, rows: 40 }) },
  { viewport: viewport({ cols: 80, rows: 24 }) },
  { viewport: viewport({ cols: 60, rows: 18 }) },
];

afterEach(() => {
  teardownVisualFixture();
});

describe('picker tree geometry', () => {
  it.each(CASES)(
    'pins OpenCode tree columns at $viewport.cols x $viewport.rows',
    async (geometryCase) => {
      const scenario = requireScenario(SCENARIO_ID);
      const checkpoint = requireCheckpoint(scenario);
      const handle = await mountGalleryScenario({
        scenario,
        checkpoint,
        viewport: geometryCase.viewport,
      });

      try {
        const frame = await handle.waitForCheckpoint();
        const provenance = ArtifactProvenanceSchema.parse({
          scenarioId: scenario.id,
          scenarioTitle: scenario.title,
          fixtureVersion: scenario.fixtureVersion,
          checkpointId: checkpoint.id,
          viewport: geometryCase.viewport,
        });
        const grid = await parseTerminalFrame({
          ansi: frame,
          identity: createFrameIdentity(provenance),
          projectRoot: process.cwd(),
        });

        const branch = glyph('treeBranch');
        const last = glyph('treeLast');
        const mid = glyph('treeMid');
        const disclosureClosed = glyph('disclosureClosed');
        const disclosureOpen = glyph('disclosureOpen');

        const connectorEntries: {
          readonly rowIndex: number;
          readonly row: readonly Cell[];
          readonly column: number;
        }[] = [];
        const disclosureEntries: {
          readonly rowIndex: number;
          readonly row: readonly Cell[];
          readonly column: number;
        }[] = [];

        for (const [rowIndex, row] of grid.cells.entries()) {
          const line = lineOf(row);
          if (line.includes(branch) || line.includes(last)) {
            const connectorColumns = [...columnsOf(row, branch), ...columnsOf(row, last)].toSorted(
              (left, right) => left - right,
            );
            const connectorColumn = connectorColumns[0];
            if (connectorColumn !== undefined) {
              connectorEntries.push({ rowIndex, row, column: connectorColumn });
            }
          }
          if (line.includes(disclosureClosed) || line.includes(disclosureOpen)) {
            for (const column of columnsOf(row, disclosureClosed)) {
              disclosureEntries.push({ rowIndex, row, column });
            }
            for (const column of columnsOf(row, disclosureOpen)) {
              disclosureEntries.push({ rowIndex, row, column });
            }
          }
        }

        let smallestConnector: number | undefined;
        for (const entry of connectorEntries) {
          if (smallestConnector === undefined || entry.column < smallestConnector) {
            smallestConnector = entry.column;
          }
        }

        const level1Columns: number[] = [];
        const level2Columns: number[] = [];
        const classified = connectorEntries.map((entry) => {
          const hasMidBefore =
            smallestConnector !== undefined &&
            entry.row.some(
              (cell, index) =>
                index < entry.column && index >= smallestConnector && cell.grapheme === mid,
            );
          const level2 =
            smallestConnector !== undefined && (hasMidBefore || entry.column > smallestConnector);
          if (level2) level2Columns.push(entry.column);
          else level1Columns.push(entry.column);
          return { ...entry, level2 };
        });

        expect(new Set(level1Columns).size).toBeLessThanOrEqual(1);
        expect(level1Columns.length).toBeGreaterThanOrEqual(2);

        expect(level2Columns.length).toBeGreaterThanOrEqual(1);
        if (level2Columns.length >= 2) {
          expect(new Set(level2Columns).size).toBeLessThanOrEqual(1);
        }

        const allDisclosureColumns = disclosureEntries.map((entry) => entry.column);
        expect(allDisclosureColumns.length).toBeGreaterThan(0);
        expect(new Set(allDisclosureColumns).size).toBeLessThanOrEqual(1);
        const modelTrailing = disclosureEntries.find(
          (entry) => !classified.some((item) => item.rowIndex === entry.rowIndex),
        );
        expect(modelTrailing).toBeDefined();
        const trailingColumn = modelTrailing?.column;
        expect(typeof trailingColumn).toBe('number');
        expect(allDisclosureColumns.every((column) => column === trailingColumn)).toBe(true);

        if (typeof trailingColumn !== 'number') {
          throw new Error('trailing column missing');
        }

        for (const entry of classified) {
          let modelAbove: (typeof disclosureEntries)[number] | undefined;
          for (const item of disclosureEntries) {
            if (item.rowIndex >= entry.rowIndex) break;
            if (classified.some((child) => child.rowIndex === item.rowIndex)) continue;
            modelAbove = item;
          }
          expect(modelAbove).toBeDefined();
          if (modelAbove === undefined) continue;
          expect(lastInkColumnBefore(entry.row, trailingColumn)).toBe(
            lastInkColumnBefore(modelAbove.row, trailingColumn),
          );
        }
      } finally {
        await handle.unmount();
      }
    },
  );

  it('puts the chevron in the same column on an option-family list and a provider-merged list', async () => {
    const at = viewport({ cols: 120, rows: 40 });
    const familyColumns = await disclosureColumns('overlay-planner-picker-cursor', at);
    const catalogColumns = await disclosureColumns('overlay-planner-picker-catalog', at);

    expect(familyColumns).toHaveLength(1);
    expect(catalogColumns).toHaveLength(1);
    expect(familyColumns[0]).toBe(catalogColumns[0]);
  });
});

const lineOf = (row: readonly Cell[]): string => row.map((cell) => cell.grapheme).join('');

function columnsOf(row: readonly Cell[], grapheme: string): number[] {
  const columns: number[] = [];
  for (const [column, cell] of row.entries()) {
    if (cell.grapheme === grapheme) columns.push(column);
  }
  return columns;
}

function lastInkColumnBefore(row: readonly Cell[], limit: number): number | undefined {
  let last: number | undefined;
  for (const [column, cell] of row.entries()) {
    if (column >= limit) break;
    if (cell.grapheme !== ' ' && cell.grapheme !== '') last = column;
  }
  return last;
}

function requireScenario(id: string) {
  const scenario = findVisualScenario(id);
  if (scenario === undefined) throw new Error(`Missing visual scenario ${id}`);
  return scenario;
}

function requireCheckpoint(scenario: ReturnType<typeof requireScenario>) {
  const checkpoint = scenario.checkpoints[0];
  if (checkpoint === undefined) throw new Error(`Missing checkpoint for ${scenario.id}`);
  return checkpoint;
}

async function disclosureColumns(scenarioId: string, at: Viewport): Promise<number[]> {
  const scenario = requireScenario(scenarioId);
  const checkpoint = requireCheckpoint(scenario);
  const handle = await mountGalleryScenario({ scenario, checkpoint, viewport: at });
  try {
    const frame = await handle.waitForCheckpoint();
    const provenance = ArtifactProvenanceSchema.parse({
      scenarioId: scenario.id,
      scenarioTitle: scenario.title,
      fixtureVersion: scenario.fixtureVersion,
      checkpointId: checkpoint.id,
      viewport: at,
    });
    const grid = await parseTerminalFrame({
      ansi: frame,
      identity: createFrameIdentity(provenance),
      projectRoot: process.cwd(),
    });
    const columns = new Set<number>();
    for (const row of grid.cells) {
      for (const column of columnsOf(row, glyph('disclosureClosed'))) columns.add(column);
      for (const column of columnsOf(row, glyph('disclosureOpen'))) columns.add(column);
    }
    return [...columns];
  } finally {
    await handle.unmount();
  }
}
