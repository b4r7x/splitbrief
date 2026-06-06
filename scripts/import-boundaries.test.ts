import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findImportBoundaryViolations } from './import-boundaries.js';

describe('findImportBoundaryViolations', () => {
  let root: string;

  const write = (relPath: string, source: string): void => {
    const full = join(root, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, source);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'boundaries-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('flags src/components importing from src/features (regression for old terminal-width import)', () => {
    write('features/workflow/layout/terminal-width.ts', 'export const x = 1;');
    write(
      'components/overlays/overlay-panel.tsx',
      "import { x } from '../../features/workflow/layout/terminal-width.js';\nexport const y = x;",
    );

    const violations = findImportBoundaryViolations(root);

    expect(violations).toHaveLength(1);
    const [violation] = violations;
    expect(violation?.file).toBe('components/overlays/overlay-panel.tsx');
    expect(violation?.reason).toContain('src/components/** must not import');
  });

  it('flags a feature importing from a sibling feature (regression for summary->workflow)', () => {
    write('features/workflow/status-glyph.ts', 'export const g = 1;');
    write(
      'features/summary/components/evidence.tsx',
      "import { g } from '../../workflow/status-glyph.js';\nexport const v = g;",
    );

    const violations = findImportBoundaryViolations(root);

    expect(violations).toHaveLength(1);
    const [violation] = violations;
    expect(violation?.reason).toContain('features/summary');
    expect(violation?.reason).toContain('features/workflow');
  });

  it('flags engine importing from top-level hooks/components/cli, depth-independently', () => {
    write('hooks/use-filterable-list.ts', 'export const h = 1;');
    write(
      'engine/streaming/parser.ts',
      "import { h } from '../../hooks/use-filterable-list.js';\nexport const p = h;",
    );

    const violations = findImportBoundaryViolations(root);

    expect(violations).toHaveLength(1);
    const [violation] = violations;
    expect(violation?.file).toBe('engine/streaming/parser.ts');
    expect(violation?.reason).toContain('src/engine/** must not import from src/hooks/**');
  });

  it('allows engine importing from shared utils/core', () => {
    write('utils/format.ts', 'export const f = 1;');
    write(
      'engine/streaming/parser.ts',
      "import { f } from '../../utils/format.js';\nexport const p = f;",
    );

    expect(findImportBoundaryViolations(root)).toHaveLength(0);
  });

  it('allows intra-feature imports', () => {
    write('features/workflow/a.ts', 'export const a = 1;');
    write(
      'features/workflow/components/b.tsx',
      "import { a } from '../a.js';\nexport const b = a;",
    );

    expect(findImportBoundaryViolations(root)).toHaveLength(0);
  });

  it('allows features and components importing shared utils/core', () => {
    write('utils/terminal-width.ts', 'export const w = 1;');
    write('core/task-status-glyph.ts', 'export const g = 1;');
    write(
      'components/overlays/overlay-panel.tsx',
      "import { w } from '../../utils/terminal-width.js';\nexport const y = w;",
    );
    write(
      'features/summary/components/evidence.tsx',
      "import { g } from '../../../core/task-status-glyph.js';\nexport const v = g;",
    );

    expect(findImportBoundaryViolations(root)).toHaveLength(0);
  });

  it('ignores test files', () => {
    write('features/workflow/status-glyph.ts', 'export const g = 1;');
    write(
      'features/summary/components/evidence.test.ts',
      "import { g } from '../../workflow/status-glyph.js';\nexport const v = g;",
    );

    expect(findImportBoundaryViolations(root)).toHaveLength(0);
  });

  it('flags a lower layer importing from a higher layer (core -> engine, rank 2 -> 3)', () => {
    write('engine/events/types.ts', 'export type EventBus = { publish: () => void };');
    write(
      'core/state/machine.ts',
      "import type { EventBus } from '../../engine/events/types.js';\nexport type X = EventBus;",
    );

    const violations = findImportBoundaryViolations(root);

    expect(violations).toHaveLength(1);
    const [violation] = violations;
    expect(violation?.file).toBe('core/state/machine.ts');
    expect(violation?.reason).toContain(
      'src/core/** (layer rank 2) must not import from src/engine/**',
    );
  });

  it('flags a value import from stores into engine (same-rank, non-type-only)', () => {
    write('engine/events/bus.ts', 'export const createEventBus = () => ({});');
    write(
      'stores/workflow/workflow.ts',
      "import { createEventBus } from '../../engine/events/bus.js';\nexport const x = createEventBus;",
    );

    const violations = findImportBoundaryViolations(root);

    expect(violations).toHaveLength(1);
    const [violation] = violations;
    expect(violation?.file).toBe('stores/workflow/workflow.ts');
    expect(violation?.reason).toContain('src/stores/** must not import from src/engine/**');
  });

  it('allows the sanctioned type-only stores -> engine channel', () => {
    write('engine/events/types.ts', 'export type EngineEvent = { type: string };');
    write(
      'stores/workflow/events.ts',
      "import type { EngineEvent } from '../../engine/events/types.js';\nexport type State = { events: EngineEvent[] };",
    );

    expect(findImportBoundaryViolations(root)).toHaveLength(0);
  });

  it('allows same-rank UI composition (features -> components, components -> hooks)', () => {
    write('components/session-row.tsx', 'export const Row = () => null;');
    write('hooks/use-filterable-list.ts', 'export const useList = () => [];');
    write(
      'features/home/screen.tsx',
      "import { Row } from '../../components/session-row.js';\nexport const Screen = Row;",
    );
    write(
      'components/pickers/filterable-list.tsx',
      "import { useList } from '../../hooks/use-filterable-list.js';\nexport const L = useList;",
    );

    expect(findImportBoundaryViolations(root)).toHaveLength(0);
  });

  it('reports no violations on the real src tree', () => {
    const violations = findImportBoundaryViolations('src');
    expect(violations).toEqual([]);
  });
});
