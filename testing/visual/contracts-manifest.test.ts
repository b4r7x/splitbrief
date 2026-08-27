import { describe, expect, it } from 'vitest';
import type { CropArtifactIdentity, FrameArtifactIdentity } from './contracts/artifact-identity.js';
import { getArtifactTargetKey, getFailureArtifactIdentity } from './contracts/failure-identity.js';
import {
  type CleanupFailureTarget,
  CleanupFailureTargetSchema,
  type Failure,
  FailureSchema,
  type SelectionFailureTarget,
  SelectionFailureTargetSchema,
} from './contracts/failures.js';
import { artifactKey, elementId, safeId } from './contracts/identifiers.js';
import {
  MAX_MANIFEST_DERIVED_PIXEL_AREA,
  MAX_RENDERER_CELL_METRIC_PX,
  MIN_RENDERER_CELL_METRIC_PX,
} from './contracts/limits.js';
import { collectDiagnosticArtifactKeys } from './contracts/manifest-accounting.js';
import {
  type ControlPolicyMetadata,
  ControlPolicyMetadataSchema,
  type DeterminismEnvelope,
  DeterminismEnvelopeSchema,
  type HyperlinkPolicyMetadata,
  HyperlinkPolicyMetadataSchema,
  type RendererMetadata,
  RendererMetadataSchema,
  type Warning,
  WarningSchema,
} from './contracts/manifest-fields.js';
import {
  type Manifest,
  ManifestSchema,
  parseManifest,
  serializeManifest,
} from './contracts/manifest.js';
import {
  CATALOG_SCHEMA_VERSION,
  CELL_GRID_SCHEMA_VERSION,
  CONTROL_POLICY_VERSION,
  HYPERLINK_POLICY_VERSION,
  MANIFEST_SCHEMA_VERSION,
} from './contracts/schema-versions.js';
import { CaptureRequestSchema, CaptureTargetSchema } from './contracts/selection.js';
import {
  createCropArtifact,
  createFrameArtifact,
  createFrameIdentity,
  createVisualProvenance,
} from './visual-contract-fixtures.js';

function makeDerivedFailure(
  stage: 'svg' | 'png',
  artifact: FrameArtifactIdentity | CropArtifactIdentity,
): Failure {
  return FailureSchema.parse({
    stage,
    code: safeId(`${stage}-unavailable`),
    message: `${stage.toUpperCase()} unavailable`,
    artifact,
  });
}

function makeManifest(options: { readonly includeDerived?: boolean } = {}): Manifest {
  const includeDerived = options.includeDerived ?? false;
  const provenance = createVisualProvenance();
  const frame = createFrameArtifact({ provenance, includeDerived });
  const crop = createCropArtifact({ provenance, includeDerived });
  const request = CaptureRequestSchema.parse({ provenance, elementIds: [elementId('hero')] });
  const target = CaptureTargetSchema.parse({ provenance, elementIds: [elementId('hero')] });
  const failures = includeDerived
    ? []
    : [
        makeDerivedFailure('svg', frame.identity),
        makeDerivedFailure('png', frame.identity),
        makeDerivedFailure('svg', crop.identity),
        makeDerivedFailure('png', crop.identity),
      ];
  const determinism: DeterminismEnvelope = DeterminismEnvelopeSchema.parse({
    timezone: 'UTC',
    locale: 'en-US',
    term: 'xterm-256color',
    colorLevel: 3,
    hyperlinks: false,
    motion: false,
    clock: '2026-07-19T00:00:00.000Z',
    randomSeed: 'visual-contracts-v1',
    profile: 'unicode-color',
  });
  const controlPolicy: ControlPolicyMetadata = ControlPolicyMetadataSchema.parse({
    version: CONTROL_POLICY_VERSION,
    ansi: 'retained-diagnostic',
    txt: 'removed',
    cells: 'interpreted',
    raster: 'removed',
  });
  const hyperlinkPolicy: HyperlinkPolicyMetadata = HyperlinkPolicyMetadataSchema.parse({
    version: HYPERLINK_POLICY_VERSION,
    ansi: 'sanitized',
    txt: 'removed',
    cells: 'sanitized-structured',
    raster: 'non-interactive',
    productionFiles: 'project-relative-only',
    externalUrls: 'public-http-https-only',
  });
  const renderer: RendererMetadata | null = includeDerived
    ? RendererMetadataSchema.parse({
        name: 'sharp',
        version: '1.0.0',
        fontFamily: 'monospace',
        cellWidthPx: 8,
        cellHeightPx: 16,
      })
    : null;

  return parseManifest({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    catalogVersion: CATALOG_SCHEMA_VERSION,
    cellSchemaVersion: CELL_GRID_SCHEMA_VERSION,
    tool: { name: 'splitbrief-tui-shots', version: '1.0.0' },
    gitRevision: 'abcdef1',
    profile: 'unicode-color',
    selection: { profile: 'unicode-color', requests: [request], targets: [target] },
    determinism,
    controlPolicy,
    hyperlinkPolicy,
    renderer,
    artifacts: [frame, crop],
    warnings: [],
    failures,
  });
}

function omitProfile<T extends { readonly profile: unknown }>(value: T): Omit<T, 'profile'> {
  const { profile, ...rest } = value;
  void profile;
  return rest;
}

type ManifestWithoutProfiles = Omit<Manifest, 'profile' | 'selection' | 'determinism'> & {
  readonly selection: Omit<Manifest['selection'], 'profile'>;
  readonly determinism: Omit<Manifest['determinism'], 'profile'>;
};

function manifestWithoutProfiles(manifest: Manifest): ManifestWithoutProfiles {
  return {
    ...omitProfile(manifest),
    selection: omitProfile(manifest.selection),
    determinism: omitProfile(manifest.determinism),
  };
}

describe('visual manifest contracts', () => {
  it.each(['unicode-color', 'unicode-mono', 'ascii-mono'] as const)(
    'accepts a homogeneous %s profile triple',
    (profile) => {
      const manifest = makeManifest();
      const parsed = parseManifest({
        ...manifest,
        profile,
        selection: { ...manifest.selection, profile },
        determinism: { ...manifest.determinism, profile },
      });

      expect(parsed.profile).toBe(profile);
      expect(parsed.selection.profile).toBe(profile);
      expect(parsed.determinism.profile).toBe(profile);
    },
  );

  it.each([
    [
      'top-level versus selection',
      { profile: 'unicode-mono', selection: 'unicode-color', determinism: 'unicode-mono' },
    ],
    [
      'selection versus top-level',
      { profile: 'unicode-color', selection: 'unicode-mono', determinism: 'unicode-color' },
    ],
    [
      'top-level versus determinism',
      { profile: 'unicode-mono', selection: 'unicode-mono', determinism: 'unicode-color' },
    ],
    [
      'determinism versus top-level',
      { profile: 'unicode-color', selection: 'unicode-color', determinism: 'unicode-mono' },
    ],
    [
      'selection versus determinism',
      { profile: 'ascii-mono', selection: 'unicode-color', determinism: 'unicode-mono' },
    ],
    [
      'determinism versus selection',
      { profile: 'ascii-mono', selection: 'unicode-mono', determinism: 'unicode-color' },
    ],
  ] as const)('rejects a %s pairwise profile mismatch', (_location, profiles) => {
    const manifest = makeManifest();
    expect(
      ManifestSchema.safeParse({
        ...manifest,
        profile: profiles.profile,
        selection: { ...manifest.selection, profile: profiles.selection },
        determinism: { ...manifest.determinism, profile: profiles.determinism },
      }).success,
    ).toBe(false);
  });

  it('rejects a missing profile when the other two fields explicitly select another profile', () => {
    const manifest = makeManifest();
    const explicit = 'unicode-mono';
    expect(
      ManifestSchema.safeParse({
        ...manifestWithoutProfiles(manifest),
        profile: explicit,
        selection: { ...omitProfile(manifest.selection), profile: explicit },
      }).success,
    ).toBe(false);
    expect(
      ManifestSchema.safeParse({
        ...manifestWithoutProfiles(manifest),
        profile: explicit,
        determinism: { ...omitProfile(manifest.determinism), profile: explicit },
      }).success,
    ).toBe(false);
    expect(
      ManifestSchema.safeParse({
        ...manifestWithoutProfiles(manifest),
        selection: { ...omitProfile(manifest.selection), profile: explicit },
        determinism: { ...omitProfile(manifest.determinism), profile: explicit },
      }).success,
    ).toBe(false);
  });

  it.each(['profile', 'selection.profile', 'determinism.profile'] as const)(
    'rejects a future profile value at %s',
    (location) => {
      const manifest = makeManifest();
      const future = 'unicode-rainbow';
      const value =
        location === 'profile'
          ? { ...manifest, profile: future }
          : location === 'selection.profile'
            ? { ...manifest, selection: { ...manifest.selection, profile: future } }
            : { ...manifest, determinism: { ...manifest.determinism, profile: future } };

      expect(ManifestSchema.safeParse(value).success).toBe(false);
    },
  );

  it('canonicalizes and serializes the all-omitted legacy profile triple', () => {
    const parsed = parseManifest(manifestWithoutProfiles(makeManifest()));

    expect(parsed.profile).toBe('unicode-color');
    expect(parsed.selection.profile).toBe('unicode-color');
    expect(parsed.determinism.profile).toBe('unicode-color');
    const serialized = JSON.parse(serializeManifest(parsed));
    expect(serialized).toMatchObject({
      profile: 'unicode-color',
      selection: { profile: 'unicode-color' },
      determinism: { profile: 'unicode-color' },
    });
  });

  it('rejects profile-like extra fields under the strict manifest contract', () => {
    const manifest = makeManifest();
    expect(
      ManifestSchema.safeParse({ ...manifest, terminalProfile: 'unicode-color' }).success,
    ).toBe(false);
  });

  it('bounds renderer metrics, rejects blank identity, and accepts exact policy envelopes', () => {
    const renderer: RendererMetadata = RendererMetadataSchema.parse({
      name: 'sharp',
      version: '1.0.0',
      fontFamily: 'monospace',
      cellWidthPx: MIN_RENDERER_CELL_METRIC_PX,
      cellHeightPx: MAX_RENDERER_CELL_METRIC_PX,
    });
    for (const invalidMetric of [0, Number.MIN_VALUE, 1.5, MAX_RENDERER_CELL_METRIC_PX + 1]) {
      expect(
        RendererMetadataSchema.safeParse({ ...renderer, cellWidthPx: invalidMetric }).success,
      ).toBe(false);
    }
    for (const field of ['name', 'fontFamily'] as const) {
      expect(RendererMetadataSchema.safeParse({ ...renderer, [field]: '   ' }).success).toBe(false);
    }
    expect(RendererMetadataSchema.safeParse({ ...renderer, version: '' }).success).toBe(false);
  });

  it('serializes a self-contained manifest with complete artifact accounting', () => {
    const manifest = makeManifest();
    const serialized = serializeManifest(manifest);
    const reparsed = parseManifest(JSON.parse(serialized));
    const artifactKeys = collectDiagnosticArtifactKeys(manifest);
    const firstFailure = manifest.failures[0];
    if (!firstFailure) throw new Error('manifest fixture has no derived failure');

    expect(serialized.endsWith('\n')).toBe(true);
    expect(reparsed).toEqual(manifest);
    expect(reparsed.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
    expect(reparsed.catalogVersion).toBe(CATALOG_SCHEMA_VERSION);
    expect(reparsed.cellSchemaVersion).toBe(CELL_GRID_SCHEMA_VERSION);
    expect(artifactKeys).toEqual(
      new Set(manifest.artifacts.map((artifact) => artifact.identity.key)),
    );
    expect(manifest.artifacts.map((artifact) => getArtifactTargetKey(artifact.identity))).toEqual([
      'home-empty:ready:120x40:frame',
      'home-empty:ready:120x40:crop:hero',
    ]);
    expect(getFailureArtifactIdentity(firstFailure)).not.toBeNull();
  });

  it('accepts successful derived artifacts only with renderer and coherent SVG provenance', () => {
    const manifest = makeManifest({ includeDerived: true });
    expect(manifest.renderer).not.toBeNull();
    expect(manifest.failures).toEqual([]);
    expect(ManifestSchema.safeParse({ ...manifest, renderer: null }).success).toBe(false);
    expect(
      ManifestSchema.safeParse({
        ...manifest,
        artifacts: manifest.artifacts.map((artifact, index) =>
          index === 0 ? { ...artifact, files: { ...artifact.files, svg: null } } : artifact,
        ),
      }).success,
    ).toBe(false);
  });

  it('accepts derived output immediately below the aggregate pixel cap and rejects above it', () => {
    const manifest = makeManifest({ includeDerived: true });
    const belowRenderer = RendererMetadataSchema.parse({
      name: 'sharp',
      version: '1.0.0',
      fontFamily: 'monospace',
      cellWidthPx: 161,
      cellHeightPx: 161,
    });
    const aboveRenderer = RendererMetadataSchema.parse({
      name: 'sharp',
      version: '1.0.0',
      fontFamily: 'monospace',
      cellWidthPx: 162,
      cellHeightPx: 162,
    });
    const derivedArea = (renderer: RendererMetadata) =>
      manifest.artifacts.reduce(
        (sum, artifact) =>
          sum +
          artifact.dimensions.cols *
            renderer.cellWidthPx *
            artifact.dimensions.rows *
            renderer.cellHeightPx *
            (Number(artifact.files.svg !== null) + Number(artifact.files.png !== null)),
        0,
      );

    const belowTotal = derivedArea(belowRenderer);
    const aboveTotal = derivedArea(aboveRenderer);
    expect(belowTotal).toBeLessThanOrEqual(MAX_MANIFEST_DERIVED_PIXEL_AREA);
    expect(aboveTotal).toBeGreaterThan(MAX_MANIFEST_DERIVED_PIXEL_AREA);

    expect(ManifestSchema.safeParse({ ...manifest, renderer: belowRenderer }).success).toBe(true);
    const aboveResult = ManifestSchema.safeParse({ ...manifest, renderer: aboveRenderer });
    expect(aboveResult.success).toBe(false);
    if (!aboveResult.success) {
      expect(
        aboveResult.error.issues.some((issue) =>
          issue.message.includes(`${MAX_MANIFEST_DERIVED_PIXEL_AREA} aggregate pixels`),
        ),
      ).toBe(true);
    }
  });

  it('rejects missing, duplicate, contradictory, and unrelated manifest outcomes', () => {
    const manifest = makeManifest();
    const firstArtifact = manifest.artifacts[0];
    const firstFailure = manifest.failures[0];
    if (!firstArtifact || !firstFailure) throw new Error('manifest fixture is incomplete');

    expect(
      ManifestSchema.safeParse({ ...manifest, failures: manifest.failures.slice(1) }).success,
    ).toBe(false);
    expect(
      ManifestSchema.safeParse({ ...manifest, artifacts: [...manifest.artifacts, firstArtifact] })
        .success,
    ).toBe(false);
    expect(
      ManifestSchema.safeParse({ ...manifest, failures: [...manifest.failures, firstFailure] })
        .success,
    ).toBe(false);
    expect(
      ManifestSchema.safeParse({
        ...manifest,
        failures: [
          ...manifest.failures,
          FailureSchema.parse({
            stage: 'write',
            code: safeId('write-failed'),
            message: 'Write failed',
            artifact: firstArtifact.identity,
          }),
        ],
      }).success,
    ).toBe(false);
    const warning: Warning = WarningSchema.parse({
      code: safeId('unknown-artifact'),
      message: 'Unknown artifact warning',
      artifactKey: artifactKey('unknown:frame'),
    });
    expect(ManifestSchema.safeParse({ ...manifest, warnings: [warning] }).success).toBe(false);
  });

  it('accounts for a selection failure without claiming any capture succeeded', () => {
    const manifest = makeManifest();
    const provenance = createVisualProvenance();
    const request = CaptureRequestSchema.parse({ provenance, elementIds: [elementId('hero')] });
    const target: SelectionFailureTarget = SelectionFailureTargetSchema.parse({
      kind: 'capture',
      provenance,
    });
    const selectionFailure = FailureSchema.parse({
      stage: 'selection',
      code: safeId('unsupported-selection'),
      message: 'Viewport is unsupported for this scenario',
      target,
    });
    const failedSelection = {
      ...manifest,
      selection: { requests: [request], targets: [] },
      renderer: null,
      artifacts: [],
      failures: [selectionFailure],
    };

    expect(ManifestSchema.safeParse(failedSelection).success).toBe(true);
    expect(
      ManifestSchema.safeParse({ ...manifest, failures: [...manifest.failures, selectionFailure] })
        .success,
    ).toBe(false);
    expect(getFailureArtifactIdentity(selectionFailure)).toBeNull();
  });

  it('models structured selection and cleanup failure targets without free-form identities', () => {
    const provenance = createVisualProvenance();
    const identity = createFrameIdentity(provenance);
    const selectionTarget: SelectionFailureTarget = SelectionFailureTargetSchema.parse({
      kind: 'capture',
      provenance,
    });
    const cleanupTarget: CleanupFailureTarget = CleanupFailureTargetSchema.parse({
      kind: 'artifact',
      artifact: identity,
    });

    expect(selectionTarget.kind).toBe('capture');
    expect(cleanupTarget.kind).toBe('artifact');
    expect(
      CleanupFailureTargetSchema.safeParse({ kind: 'path', path: '/tmp/private' }).success,
    ).toBe(false);
  });

  it('rejects a crop whose parent frame has different provenance', () => {
    const manifest = makeManifest();
    const crop = manifest.artifacts.find((artifact) => artifact.identity.kind === 'crop');
    if (crop === undefined) throw new Error('Manifest fixture is missing its crop');
    const alternateProvenance = {
      ...crop.identity.provenance,
      scenarioTitle: 'Different source frame',
    };
    const mismatchedFrame = createFrameArtifact({
      provenance: alternateProvenance,
      includeDerived: true,
    });

    expect(
      ManifestSchema.safeParse({ ...manifest, artifacts: [mismatchedFrame, crop] }).success,
    ).toBe(false);
  });
});
