import { describe, expect, it } from 'vitest';
import { ACTIVE_OVERLAYS, ALL_SCREENS } from '../../src/core/navigation/types.js';
import {
  CheckpointDefinitionSchema,
  CheckpointKindSchema,
  type CheckpointDefinition,
  type CheckpointKind,
  ElementDefinitionSchema,
  type ElementDefinition,
  OverlaySurfaceSchema,
  type OverlaySurface,
  ScenarioDefinitionSchema,
  type ScenarioDefinition,
  ScreenSurfaceSchema,
  type ScreenSurface,
  type Surface,
  SurfaceKindSchema,
  type SurfaceKind,
  SurfaceSchema,
} from './contracts/catalog.js';
import {
  CellRectSchema,
  formatViewport,
  isCellRectInViewport,
  isFullFrameRect,
  parseViewport,
  viewport,
} from './contracts/geometry.js';
import {
  HyperlinkSchema,
  ProjectRelativePathSchema,
  type ProjectRelativePath,
  PublicHttpUrlSchema,
  type PublicHttpUrl,
  sanitizeHyperlink,
} from './contracts/hyperlinks.js';
import {
  ArtifactKeySchema,
  CheckpointIdSchema,
  ElementIdSchema,
  RelativeArtifactPathSchema,
  SafeIdSchema,
  ScenarioIdSchema,
  artifactKey,
  checkpointId,
  elementId,
  isSafeId,
  isWindowsReservedName,
  relativeArtifactPath,
  safeId,
  scenarioId,
} from './contracts/identifiers.js';
import {
  MAX_VIEWPORT_CELLS,
  MAX_VIEWPORT_COLS,
  MAX_VIEWPORT_ROWS,
  MIN_VIEWPORT_COLS,
  MIN_VIEWPORT_ROWS,
} from './contracts/limits.js';
import { containsUnsafeNetworkReference } from './contracts/network-policy.js';
import { containsHostPath } from './contracts/path-policy.js';
import {
  GitRevisionSchema,
  PersistedDiagnosticTextSchema,
  PersistedMetadataTextSchema,
  ToolVersionSchema,
  containsUnsafePathUnicode,
  isPublicHostname,
  isSafePersistedTerminalText,
  isSafePersistedText,
} from './contracts/persisted-data.js';

describe('visual contract boundaries', () => {
  it('round-trips supported viewports and rejects every numeric boundary violation', () => {
    expect([
      viewport({ cols: 120, rows: 40 }),
      parseViewport('80x24'),
      parseViewport('60x18'),
    ]).toEqual([
      { cols: 120, rows: 40 },
      { cols: 80, rows: 24 },
      { cols: 60, rows: 18 },
    ]);
    expect(formatViewport(viewport({ cols: 120, rows: 40 }))).toBe('120x40');
    expect(viewport({ cols: MIN_VIEWPORT_COLS, rows: MIN_VIEWPORT_ROWS })).toEqual({
      cols: 1,
      rows: 1,
    });
    expect(
      viewport({ cols: MAX_VIEWPORT_COLS, rows: MAX_VIEWPORT_CELLS / MAX_VIEWPORT_COLS }),
    ).toEqual({ cols: 500, rows: 100 });

    for (const invalid of [
      { cols: 0, rows: 1 },
      { cols: -1, rows: 1 },
      { cols: 1, rows: 0 },
      { cols: 1, rows: -1 },
      { cols: MAX_VIEWPORT_COLS + 1, rows: 1 },
      { cols: 1, rows: MAX_VIEWPORT_ROWS + 1 },
      { cols: MAX_VIEWPORT_COLS, rows: MAX_VIEWPORT_CELLS / MAX_VIEWPORT_COLS + 1 },
    ]) {
      expect(() => viewport(invalid)).toThrow();
    }
    expect(() => parseViewport('120X40')).toThrow();
    expect(() => parseViewport('120x40px')).toThrow();
  });

  it('validates cell rectangles against the selected viewport', () => {
    const sourceViewport = viewport({ cols: 120, rows: 40 });
    const full = CellRectSchema.parse({ x: 0, y: 0, width: 120, height: 40 });
    const crop = CellRectSchema.parse({ x: 10, y: 5, width: 50, height: 20 });
    const escaped = CellRectSchema.parse({ x: 119, y: 39, width: 2, height: 1 });

    expect(isFullFrameRect(full, sourceViewport)).toBe(true);
    expect(isCellRectInViewport(crop, sourceViewport)).toBe(true);
    expect(isCellRectInViewport(escaped, sourceViewport)).toBe(false);
    expect(CellRectSchema.safeParse({ x: -1, y: 0, width: 1, height: 1 }).success).toBe(false);
    expect(CellRectSchema.safeParse({ x: 0, y: 0, width: 0, height: 1 }).success).toBe(false);
  });

  it('accepts canonical IDs and paths while rejecting traversal and reserved device names', () => {
    expect(safeId('workflow-review')).toBe('workflow-review');
    expect(scenarioId('home-empty')).toBe('home-empty');
    expect(checkpointId('ready')).toBe('ready');
    expect(elementId('summary-hero')).toBe('summary-hero');
    expect(artifactKey('home-empty:ready:frame')).toBe('home-empty:ready:frame');
    expect(relativeArtifactPath('home-empty/120x40/ready/frame.cells.json')).toBe(
      'home-empty/120x40/ready/frame.cells.json',
    );
    expect(isSafeId('workflow-review')).toBe(true);

    for (const invalidId of ['', 'UPPER', 'with space', '../escape', 'con', 'com1']) {
      expect(SafeIdSchema.safeParse(invalidId).success).toBe(false);
      expect(ScenarioIdSchema.safeParse(invalidId).success).toBe(false);
      expect(CheckpointIdSchema.safeParse(invalidId).success).toBe(false);
      expect(ElementIdSchema.safeParse(invalidId).success).toBe(false);
    }
    for (const reservedName of ['CON', 'con.txt', 'COM1', 'COM¹.log', 'LPT².', 'NUL   ']) {
      expect(isWindowsReservedName(reservedName)).toBe(true);
    }
    for (const invalidKey of ['home:con', 'home::frame', 'home/frame', 'home frame']) {
      expect(ArtifactKeySchema.safeParse(invalidKey).success).toBe(false);
    }
    for (const invalidPath of [
      '../frame.ansi',
      '/tmp/frame.ansi',
      'C:/temp/frame.ansi',
      'home\\frame.ansi',
      'home/%2e%2e/frame.ansi',
      'home//frame.ansi',
      'home/con/frame.ansi',
      'home/frame.ansi.',
    ]) {
      expect(RelativeArtifactPathSchema.safeParse(invalidPath).success).toBe(false);
    }
  });

  it('covers every navigable screen and overlay surface with stable schema values', () => {
    const screens: readonly ScreenSurface[] = ALL_SCREENS;
    const overlays: readonly OverlaySurface[] = ACTIVE_OVERLAYS;
    const kinds: readonly SurfaceKind[] = ['screen', 'overlay'];
    for (const screen of screens) {
      expect(SurfaceSchema.parse({ kind: 'screen', screen })).toEqual({ kind: 'screen', screen });
    }
    for (const overlay of overlays) {
      const surface = { kind: 'overlay', overlay, underlyingScreen: 'workflow' } satisfies Surface;
      expect(SurfaceSchema.parse(surface)).toEqual(surface);
    }

    for (const screen of screens) expect(ScreenSurfaceSchema.parse(screen)).toBe(screen);
    for (const overlay of overlays) expect(OverlaySurfaceSchema.parse(overlay)).toBe(overlay);
    for (const kind of kinds) expect(SurfaceKindSchema.parse(kind)).toBe(kind);
    expect(
      SurfaceSchema.safeParse({ kind: 'overlay', overlay: 'unknown', underlyingScreen: 'home' })
        .success,
    ).toBe(false);
  });

  it('accepts a complete scenario and rejects duplicate catalog coordinates', () => {
    const kinds: readonly CheckpointKind[] = [
      'ready',
      'idle',
      'planning',
      'implementation',
      'review',
      'question',
      'success',
      'failure',
    ];
    for (const kind of kinds) expect(CheckpointKindSchema.parse(kind)).toBe(kind);
    expect(CheckpointKindSchema.safeParse('cancelled').success).toBe(false);

    const checkpoint: CheckpointDefinition = CheckpointDefinitionSchema.parse({
      id: checkpointId('ready'),
      title: 'Ready',
      kind: CheckpointKindSchema.parse('ready'),
      marker: 'Home ready',
      timeoutMs: 5_000,
    });
    const element: ElementDefinition = ElementDefinitionSchema.parse({
      id: elementId('hero'),
      title: 'Hero',
      required: true,
    });
    const scenario: ScenarioDefinition = ScenarioDefinitionSchema.parse({
      id: scenarioId('home-empty'),
      title: 'Home empty',
      surface: { kind: 'screen', screen: 'home' },
      fixtureVersion: 1,
      viewports: [
        viewport({ cols: 120, rows: 40 }),
        viewport({ cols: 80, rows: 24 }),
        viewport({ cols: 60, rows: 18 }),
      ],
      checkpoints: [checkpoint],
      elements: [element],
    });

    expect(
      ScenarioDefinitionSchema.safeParse({
        ...scenario,
        viewports: [scenario.viewports[0], scenario.viewports[0]],
      }).success,
    ).toBe(false);
    expect(
      ScenarioDefinitionSchema.safeParse({ ...scenario, checkpoints: [checkpoint, checkpoint] })
        .success,
    ).toBe(false);
    expect(
      ScenarioDefinitionSchema.safeParse({ ...scenario, elements: [element, element] }).success,
    ).toBe(false);
  });

  it('applies persisted-data policy to controls, paths, hosts, URLs, and metadata', () => {
    for (const safe of ['Synthetic fixture text', 'src/app/root.tsx', 'https://openai.com/docs']) {
      expect(isSafePersistedText(safe)).toBe(true);
      expect(isSafePersistedTerminalText(safe)).toBe(true);
      expect(PersistedDiagnosticTextSchema.safeParse(safe).success).toBe(true);
      expect(PersistedMetadataTextSchema.safeParse(safe).success).toBe(true);
    }
    for (const hostile of [
      '\u001b[31mred',
      '/Users/alice/private.txt',
      'C:\\Users\\alice\\private.txt',
      '\\\\server\\share\\private.txt',
      'file:///Users/alice/private.txt',
      'https://user:password@openai.com/private',
      'https://localhost/private',
      'https://10.0.0.1/private',
      'https://attacker.zzzz/private',
      'https://service.corpnet/private',
      'postgres://db.internal/app',
      `ghu_${'A'.repeat(36)}`,
      '%2FUsers%2Falice%2Fprivate.txt',
    ]) {
      expect(isSafePersistedText(hostile)).toBe(false);
    }
    expect(containsUnsafePathUnicode('\u202e')).toBe(true);
    expect(containsHostPath('/Users/alice/private.txt')).toBe(true);
    expect(containsHostPath('\\Users\\alice\\private.txt')).toBe(true);
    expect(containsHostPath('~/private.txt')).toBe(true);
    for (const terminalUi of [
      '/help · /settings · /skills · ctrl+k commands',
      "/ _` | | '_ \\| __| | | |/ __| '_ \\",
      '\\__,_|_| .__/ \\__|\\__, |\\___|_| |_|',
    ]) {
      expect(containsHostPath(terminalUi)).toBe(false);
    }
    expect(containsUnsafeNetworkReference({ value: 'https://localhost/private' })).toBe(true);
    expect(containsUnsafeNetworkReference({ value: 'git:none' })).toBe(false);
    for (const privateUri of [
      'file:///Users/alice/private.txt',
      'postgres://db.internal/app',
      'ssh://git@host.internal/private',
    ]) {
      expect(containsUnsafeNetworkReference({ value: privateUri })).toBe(true);
    }
    expect(isPublicHostname('openai.com')).toBe(true);
    for (const privateHost of [
      'localhost',
      '127.0.0.1',
      'service.internal',
      'example.com',
      'host.localhost',
      'attacker.zzzz',
      'service.corpnet',
    ]) {
      expect(isPublicHostname(privateHost)).toBe(false);
      expect(containsUnsafeNetworkReference({ value: `https://${privateHost}/private` })).toBe(
        true,
      );
    }
    expect(ToolVersionSchema.safeParse('1.2.3-beta.1+build.4').success).toBe(true);
    expect(ToolVersionSchema.safeParse('v1.2.3').success).toBe(false);
    expect(GitRevisionSchema.safeParse('abcdef1').success).toBe(true);
    expect(GitRevisionSchema.safeParse('ABCDEF1').success).toBe(false);
  });

  it('sanitizes public and project-file hyperlinks and drops unsafe destinations', () => {
    const publicUrl: PublicHttpUrl = PublicHttpUrlSchema.parse('https://openai.com/docs');
    expect(
      sanitizeHyperlink({ value: 'https://openai.com/docs', projectRoot: '/project' }),
    ).toEqual({
      kind: 'external',
      url: publicUrl,
    });
    const projectFile: ProjectRelativePath = ProjectRelativePathSchema.parse('src/app.ts');
    expect(
      sanitizeHyperlink({ value: 'file:///project/src/app.ts', projectRoot: '/project' }),
    ).toEqual({ kind: 'project-file', path: projectFile });
    for (const value of [
      'https://localhost/private',
      'https://user:password@openai.com/private',
      'https://attacker.zzzz/private',
      'https://service.corpnet/private',
      'ftp://openai.com/file',
      'file:///outside/private.txt',
      'https://openai.com/%2e%2e/private',
    ]) {
      expect(sanitizeHyperlink({ value, projectRoot: '/project' })).toBeNull();
    }
    expect(ProjectRelativePathSchema.safeParse('../app.ts').success).toBe(false);
    expect(
      HyperlinkSchema.safeParse({ kind: 'external', url: 'https://localhost/private' }).success,
    ).toBe(false);
  });
});
