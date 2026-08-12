import { afterEach, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import type { EngineEventOf } from '../../../../engine/events/types.js';
import { getTerminalCellWidth } from '../../../../utils/display-text.js';
import { configStore } from '../../../../stores/project/config.js';
import type { ConversationRow } from '../types.js';
import { glyph } from '../../../../lib/glyphs.js';
import { rowText } from '../row-format/rows.js';
import { artifactWrittenRowBlock } from './artifact-card.js';

const FOOTER = glyph('treeLast');

const PROJECT_DIR = '/repo';
const SPEC_PATH = `${PROJECT_DIR}/.splitbrief/sessions/2026-08-10-add-tool-calling/spec.md`;

function artifactEvent(
  overrides: Partial<EngineEventOf<'artifact_written'>> = {},
): EngineEventOf<'artifact_written'> {
  return {
    type: 'artifact_written',
    ts: 0,
    phase: 'specifying',
    filename: 'spec.md',
    path: SPEC_PATH,
    lineCount: 284,
    excerpt: ['Overview', 'User Scenarios', 'Acceptance Criteria', 'Out of Scope'],
    omittedCount: 12,
    omittedUnit: 'section',
    ...overrides,
  };
}

function rowsFor(event: EngineEventOf<'artifact_written'>, width = 78): ConversationRow[] {
  const block = artifactWrittenRowBlock('ev', event, width);
  expect(block).not.toBeNull();
  if (block === null) throw new Error('rowsFor: block was null');
  return block.createRows(0, block.rowCount);
}

function rowAt(rows: ConversationRow[], index: number): ConversationRow {
  const found = rows.at(index);
  if (found === undefined) throw new Error(`rowAt: no row at index ${index}`);
  return found;
}

afterEach(() => {
  configStore.__testReset();
});

describe('artifactWrittenRowBlock', () => {
  it('labels the card with the artifact rather than the verb that produced it', () => {
    configStore.__testReset({ projectDir: PROJECT_DIR });

    const labels = (['research.md', 'spec.md', 'plan.md', 'tasks.md'] as const).map(
      (filename) => rowAt(rowsFor(artifactEvent({ filename })), 0).segments[0],
    );

    expect(labels.map((segment) => segment?.text)).toEqual(['Research', 'Spec', 'Plan', 'Tasks']);
    expect(labels.every((segment) => segment?.tone === 'planner' && segment.bold === true)).toBe(
      true,
    );
  });

  it('links the last row to the document and keeps the filename through the cut', () => {
    configStore.__testReset({ projectDir: PROJECT_DIR });

    const source = rowAt(rowsFor(artifactEvent(), 60), -1);
    const link = source.segments.at(-1);

    expect(rowText(source)).toContain('+ 12 more sections');
    expect(link?.tone).toBe('reviewFile');
    expect(link?.href).toBe(pathToFileURL(SPEC_PATH).href);
    expect(link?.text.startsWith('.splitbrief/')).toBe(true);
    expect(link?.text).toContain('…');
    expect(link?.text.endsWith('spec.md')).toBe(true);
  });

  // Cutting a path by width put the four artifacts of one session at four different columns,
  // because the elision moved with the filename length. Whole directories are dropped instead, so
  // every sibling breaks in the same place and they line up when they stack in the transcript.
  it('elides sibling paths to the same shape whatever the filename costs', () => {
    configStore.__testReset({ projectDir: PROJECT_DIR });
    const dir = `${PROJECT_DIR}/.splitbrief/sessions/2026-08-10-add-tool-calling`;

    const labels = (['research.md', 'spec.md', 'plan.md', 'tasks.md'] as const).map((filename) => {
      const rows = rowsFor(artifactEvent({ filename, path: `${dir}/${filename}` }), 78);
      return rowAt(rows, -1).segments.at(-1)?.text ?? '';
    });

    expect(labels).toEqual([
      '.splitbrief/…/research.md',
      '.splitbrief/…/spec.md',
      '.splitbrief/…/plan.md',
      '.splitbrief/…/tasks.md',
    ]);
    expect(new Set(labels.map((label) => label.indexOf('…'))).size).toBe(1);
  });

  it('still names the document when nothing was left out', () => {
    configStore.__testReset({ projectDir: PROJECT_DIR });

    const rows = rowsFor(
      artifactEvent({
        filename: 'tasks.md',
        path: `${PROJECT_DIR}/.splitbrief/sessions/2026-08-10-add-tool-calling/tasks.md`,
        lineCount: 2,
        excerpt: ['# Tasks', '- T001 Add the tool contract'],
        omittedCount: 0,
        omittedUnit: 'line',
      }),
    );

    expect(rows.map(rowText)).toEqual([
      'Tasks  2 lines',
      '  # Tasks',
      '  - T001 Add the tool contract',
      '',
      `  ${FOOTER} .splitbrief/sessions/2026-08-10-add-tool-calling/tasks.md`,
    ]);
  });

  it('renders excerpt lines verbatim and dim, cut at the width rather than wrapped', () => {
    configStore.__testReset({ projectDir: PROJECT_DIR });

    const excerpt = ['## Heading with `code` and a very long tail '.repeat(4).trimEnd()];
    const rows = rowsFor(artifactEvent({ excerpt }), 78);
    const body = rowAt(rows, 1);

    expect(body.segments.at(-1)?.tone).toBe('textDim');
    expect(rowText(body).trimStart().startsWith('## Heading with `code`')).toBe(true);
    expect(rowText(body).endsWith('…')).toBe(true);
    expect(rows).toHaveLength(4);
  });

  it('fits every row inside the space the row leading leaves', () => {
    configStore.__testReset({ projectDir: PROJECT_DIR });

    for (const width of [40, 78, 110]) {
      for (const row of rowsFor(artifactEvent(), width)) {
        expect(getTerminalCellWidth(rowText(row))).toBeLessThanOrEqual(width - 2);
      }
    }
  });

  it('falls back to the filename when no project directory is known', () => {
    const source = rowAt(rowsFor(artifactEvent()), -1);

    expect(source.segments.at(-1)?.text).toBe('spec.md');
    expect(source.segments.at(-1)?.href).toBeUndefined();
  });

  it('serves a window without shifting row content', () => {
    configStore.__testReset({ projectDir: PROJECT_DIR });
    const block = artifactWrittenRowBlock('ev', artifactEvent(), 78);
    if (block === null) throw new Error('block was null');

    expect(block.createRows(1, 4).map(rowText)).toEqual(
      block.createRows(0, block.rowCount).slice(1, 4).map(rowText),
    );
  });

  it('renders nothing when the excerpt is empty', () => {
    expect(artifactWrittenRowBlock('ev', artifactEvent({ excerpt: [] }), 78)).toBeNull();
  });
});
