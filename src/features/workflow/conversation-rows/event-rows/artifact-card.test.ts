import { afterEach, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import type { EngineEventOf } from '../../../../engine/events/types.js';
import { getTerminalCellWidth } from '../../../../utils/display-text/width.js';
import { configStore } from '../../../../stores/project/config.js';
import type { ConversationRow } from '../types.js';
import { rowText } from '../row-format/rows.js';
import { artifactWrittenRowBlock } from './artifact-card.js';

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
  it.each([60, 120])('replays each stored artifact as one labelled link at %i columns', (width) => {
    configStore.__testReset({ projectDir: PROJECT_DIR });
    for (const label of ['Research', 'Spec', 'Plan', 'Tasks']) {
      const filename = `${label.toLowerCase()}.md`;
      const path = SPEC_PATH.replace(/spec\.md$/u, filename);
      const rows = rowsFor(
        artifactEvent({
          filename,
          path,
          excerpt: label === 'Spec' ? [] : ['Project Overview    5 lines', 'T001 Add validator'],
        }),
        width,
      );
      expect(rows).toHaveLength(1);
      const row = rowAt(rows, 0);
      const links = row.segments.filter((segment) => segment.href !== undefined);
      expect(links).toHaveLength(1);
      const link = links[0];
      expect(link?.href).toBe(pathToFileURL(path).href);
      expect(link?.text.endsWith(filename)).toBe(true);
      if (width === 60) expect(link?.text).toContain('…');
      else expect(link?.text).toBe(path.slice(PROJECT_DIR.length + 1));
      expect(rowText(row).trim().split(/\s+/u)).toEqual([label, link?.text]);
    }
  });

  it('labels the stored artifact in the planner tone', () => {
    configStore.__testReset({ projectDir: PROJECT_DIR });

    const labels = (['research.md', 'spec.md', 'plan.md', 'tasks.md'] as const).map(
      (filename) => rowAt(rowsFor(artifactEvent({ filename })), 0).segments[0],
    );

    expect(labels.map((segment) => segment?.text)).toEqual(['Research', 'Spec', 'Plan', 'Tasks']);
    expect(labels.every((segment) => segment?.tone === 'planner' && segment.bold === true)).toBe(
      true,
    );
  });

  it('keeps the document link and filename through the cut', () => {
    configStore.__testReset({ projectDir: PROJECT_DIR });

    const source = rowAt(rowsFor(artifactEvent(), 60), -1);
    const link = source.segments.at(-1);

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
      const rows = rowsFor(artifactEvent({ filename, path: `${dir}/${filename}` }), 60);
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

  it('fits every row inside the space the row leading leaves', () => {
    configStore.__testReset({ projectDir: PROJECT_DIR });

    for (const width of [40, 78, 110]) {
      for (const row of rowsFor(artifactEvent(), width)) {
        expect(getTerminalCellWidth(rowText(row))).toBeLessThanOrEqual(width - 1);
      }
    }
  });

  it('falls back to the filename when no project directory is known', () => {
    const source = rowAt(rowsFor(artifactEvent()), -1);

    expect(source.segments.at(-1)?.text).toBe('spec.md');
    expect(source.segments.at(-1)?.href).toBeUndefined();
  });
});
