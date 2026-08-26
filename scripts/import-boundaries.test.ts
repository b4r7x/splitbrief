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
    write('features/workflow/layout/sizing.ts', 'export const x = 1;');
    write(
      'components/overlays/overlay-panel.tsx',
      "import { x } from '../../features/workflow/layout/sizing.js';\nexport const y = x;",
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

  it('allows any feature to import the shared editor feature (workflow -> editor)', () => {
    write('features/editor/brief-field-editor.tsx', 'export const E = 1;');
    write(
      'features/workflow/components/brief-review/view.tsx',
      "import { E } from '../../editor/brief-field-editor.js';\nexport const v = E;",
    );

    expect(findImportBoundaryViolations(root)).toHaveLength(0);
  });

  it('still flags the editor feature importing back into another feature', () => {
    write('features/workflow/status-glyph.ts', 'export const g = 1;');
    write(
      'features/editor/use-inline-edit-trigger.ts',
      "import { g } from '../workflow/status-glyph.js';\nexport const t = g;",
    );

    const violations = findImportBoundaryViolations(root);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain('features/editor');
    expect(violations[0]?.reason).toContain('features/workflow');
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

  it('flags engine importing from stores (stores sit above engine)', () => {
    write('stores/workflow/workflow.ts', 'export const workflowStore = {};');
    write(
      'engine/orchestrator/loop.ts',
      "import { workflowStore } from '../../stores/workflow/workflow.js';\nexport const o = workflowStore;",
    );

    const violations = findImportBoundaryViolations(root);

    expect(violations).toHaveLength(1);
    const [violation] = violations;
    expect(violation?.file).toBe('engine/orchestrator/loop.ts');
    expect(violation?.reason).toContain('src/engine/** must not import from src/stores/**');
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
    write('utils/sizing.ts', 'export const w = 1;');
    write('core/task-status-glyph.ts', 'export const g = 1;');
    write(
      'components/overlays/overlay-panel.tsx',
      "import { w } from '../../utils/sizing.js';\nexport const y = w;",
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

  it('flags a screen page importing a sibling screen page (page<->page in screens)', () => {
    write('app/screens/summary.tsx', 'export const Summary = () => null;');
    write(
      'app/screens/home.tsx',
      "import { Summary } from './summary.js';\nexport const Home = Summary;",
    );

    const violations = findImportBoundaryViolations(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe('app/screens/home.tsx');
    expect(violations[0]?.reason).toContain(
      'src/app/screens/home.tsx must not import from src/app/screens/summary.tsx',
    );
  });

  it('flags an overlay page importing a sibling overlay page (page<->page in overlays)', () => {
    write('app/overlays/settings.tsx', 'export const Settings = () => null;');
    write(
      'app/overlays/palette.tsx',
      "import { Settings } from './settings.js';\nexport const Palette = Settings;",
    );

    const violations = findImportBoundaryViolations(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain(
      'src/app/overlays/palette.tsx must not import from src/app/overlays/settings.tsx',
    );
  });

  it('flags a screen page importing an overlay page (cross-surface direct import)', () => {
    write('app/overlays/palette.tsx', 'export const Palette = () => null;');
    write(
      'app/screens/home.tsx',
      "import { Palette } from '../overlays/palette.js';\nexport const Home = Palette;",
    );

    const violations = findImportBoundaryViolations(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain(
      'src/app/screens/** and src/app/overlays/** pages must not import each other directly',
    );
  });

  it('flags a page importing the app shell (shell-guard)', () => {
    write('app/root.tsx', 'export const Root = () => null;');
    write('app/screens/home.tsx', "import { Root } from '../root.js';\nexport const Home = Root;");

    const violations = findImportBoundaryViolations(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain('pages must not import the app shell (src/app/root)');
  });

  it('flags an overlay page importing the router shell (shell-guard)', () => {
    write('app/router.tsx', 'export const Router = () => null;');
    write(
      'app/overlays/palette.tsx',
      "import { Router } from '../router.js';\nexport const P = Router;",
    );

    const violations = findImportBoundaryViolations(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain('pages must not import the app shell (src/app/router)');
  });

  it('flags a page importing the provider shell (shell-guard)', () => {
    write('app/provider.tsx', 'export const Provider = () => null;');
    write(
      'app/screens/home.tsx',
      "import { Provider } from '../provider.js';\nexport const Home = Provider;",
    );

    const violations = findImportBoundaryViolations(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain('must not import the app shell');
  });

  it('flags a page importing the layout shell (shell-guard)', () => {
    write('app/layout.tsx', 'export const Layout = () => null;');
    write(
      'app/screens/home.tsx',
      "import { Layout } from '../layout.js';\nexport const Home = Layout;",
    );

    const violations = findImportBoundaryViolations(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain('must not import the app shell');
  });

  it('allows a page composing TWO features (composition at app level)', () => {
    write('features/workflow/components/header.tsx', 'export const Header = () => null;');
    write('features/summary/components/evidence.tsx', 'export const Evidence = () => null;');
    write(
      'app/screens/home.tsx',
      "import { Header } from '../../features/workflow/components/header.js';\n" +
        "import { Evidence } from '../../features/summary/components/evidence.js';\n" +
        'export const Home = [Header, Evidence];',
    );

    expect(findImportBoundaryViolations(root)).toHaveLength(0);
  });

  it('allows a page importing shared components', () => {
    write('components/session-row.tsx', 'export const Row = () => null;');
    write(
      'app/screens/home.tsx',
      "import { Row } from '../../components/session-row.js';\nexport const Home = Row;",
    );

    expect(findImportBoundaryViolations(root)).toHaveLength(0);
  });

  it('allows the shell (root/router) importing pages', () => {
    write('app/screens/home.tsx', 'export const Home = () => null;');
    write('app/overlays/palette.tsx', 'export const Palette = () => null;');
    write(
      'app/root.tsx',
      "import { Home } from './screens/home.js';\nimport { Palette } from './overlays/palette.js';\nexport const Root = [Home, Palette];",
    );

    expect(findImportBoundaryViolations(root)).toHaveLength(0);
  });

  it('allows the router shell importing pages (composition site)', () => {
    write('app/screens/home.tsx', 'export const Home = () => null;');
    write('app/overlays/palette.tsx', 'export const Palette = () => null;');
    write(
      'app/router.tsx',
      "import { Home } from './screens/home.js';\nimport { Palette } from './overlays/palette.js';\nexport const Router = [Home, Palette];",
    );

    expect(findImportBoundaryViolations(root)).toHaveLength(0);
  });
});
