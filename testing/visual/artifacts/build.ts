import type { ArtifactIdentity } from '../contracts/artifact-identity.js';
import { ArtifactRecordSchema, type ArtifactRecord } from '../contracts/artifacts.js';
import { CellGridSchema, type CellGrid } from '../contracts/cells.js';
import {
  CheckpointDefinitionSchema,
  ScenarioDefinitionSchema,
  type CheckpointDefinition,
  type ScenarioDefinition,
} from '../contracts/catalog.js';
import { FailureSchema, type Failure } from '../contracts/failures.js';
import { safeId, type RelativeArtifactPath } from '../contracts/identifiers.js';
import {
  captureAccountingKey,
  hasMatchingProvenance,
  type CaptureSelection,
  type CaptureTarget,
} from '../contracts/selection.js';
import { tryResolveElementLocator } from '../locators/resolve.js';
import type { ResolvedElementLocator } from '../locators/types.js';
import { serializeTerminalTruth } from '../terminal/serialize/truth.js';
import { assertUniqueArtifactPaths, createArtifactFiles } from './layout.js';
import { createCropCellGrid } from './crop.js';
import { PNG_RENDERER_METADATA, renderCellGridPng, type PngRasterizer } from './png.js';
import { renderCellGridSvg } from './svg.js';
import type { StagedArtifactFile } from './staging.js';

export interface VisualFrameCapture {
  readonly scenario: ScenarioDefinition;
  readonly checkpoint: CheckpointDefinition;
  readonly grid: CellGrid;
}

export interface PendingArtifact {
  readonly record: ArtifactRecord;
  readonly files: readonly Omit<StagedArtifactFile, 'root'>[];
}

interface ArtifactBuildOutcome {
  readonly artifact: PendingArtifact | null;
  readonly failures: readonly Failure[];
}

export interface RunBuildOutcome {
  readonly artifacts: readonly PendingArtifact[];
  readonly failures: readonly Failure[];
}

export async function buildRunArtifacts(options: {
  readonly captures: readonly VisualFrameCapture[];
  readonly selection: CaptureSelection;
  readonly rasterize: PngRasterizer | undefined;
  readonly initialFailures: readonly Failure[];
}): Promise<RunBuildOutcome> {
  const artifacts: PendingArtifact[] = [];
  const failures: Failure[] = [...options.initialFailures];
  const targets = new Map(
    options.selection.targets.map((target) => [captureAccountingKey(target.provenance), target]),
  );
  const consumedTargets = new Set<string>();

  for (const captureInput of options.captures) {
    const capture = parseCapture(captureInput);
    const captureKey = captureAccountingKey(capture.grid.identity.provenance);
    const target = targets.get(captureKey);
    if (
      !target ||
      consumedTargets.has(captureKey) ||
      !hasMatchingProvenance({
        left: target.provenance,
        right: capture.grid.identity.provenance,
      })
    ) {
      throw new Error('Frame capture does not match one unique selected capture target');
    }
    consumedTargets.add(captureKey);

    appendOutcome(
      await buildArtifact({ grid: capture.grid, locator: null, rasterize: options.rasterize }),
      artifacts,
      failures,
    );
    for (const elementId of target.elementIds) {
      const crop = resolveCrop({ capture, elementId });
      if (crop.kind === 'failure') {
        failures.push(crop.failure);
        continue;
      }
      appendOutcome(
        await buildArtifact({
          grid: crop.grid,
          locator: crop.locator,
          rasterize: options.rasterize,
        }),
        artifacts,
        failures,
      );
    }
  }

  assertUniqueArtifactPaths(artifacts.map((artifact) => artifact.record.files));
  return { artifacts, failures };
}

export function pngRendererMetadataForArtifacts(
  artifactRecords: readonly ArtifactRecord[],
): typeof PNG_RENDERER_METADATA | null {
  return artifactRecords.some((artifact) => artifact.files.svg !== null)
    ? PNG_RENDERER_METADATA
    : null;
}

function parseCapture(capture: VisualFrameCapture): VisualFrameCapture {
  const scenario = ScenarioDefinitionSchema.parse(capture.scenario);
  const checkpoint = CheckpointDefinitionSchema.parse(capture.checkpoint);
  const grid = CellGridSchema.parse(capture.grid);
  if (grid.identity.kind !== 'frame') {
    throw new Error('Visual frame capture must contain a frame grid');
  }
  const provenance = grid.identity.provenance;
  if (
    provenance.scenarioId !== scenario.id ||
    provenance.scenarioTitle !== scenario.title ||
    provenance.fixtureVersion !== scenario.fixtureVersion ||
    provenance.checkpointId !== checkpoint.id ||
    !scenario.checkpoints.some((candidate) => candidate.id === checkpoint.id) ||
    !scenario.viewports.some(
      (viewport) =>
        viewport.cols === provenance.viewport.cols && viewport.rows === provenance.viewport.rows,
    )
  ) {
    throw new Error('Frame capture scenario, checkpoint, and grid provenance do not match');
  }
  return { scenario, checkpoint, grid };
}

function resolveCrop(options: {
  readonly capture: VisualFrameCapture;
  readonly elementId: CaptureTarget['elementIds'][number];
}):
  | {
      readonly kind: 'success';
      readonly grid: CellGrid;
      readonly locator: ResolvedElementLocator;
    }
  | { readonly kind: 'failure'; readonly failure: Failure } {
  const resolution = tryResolveElementLocator({
    scenario: options.capture.scenario,
    checkpoint: options.capture.checkpoint,
    grid: options.capture.grid,
    elementId: options.elementId,
  });
  if (!resolution.ok) {
    return {
      kind: 'failure',
      failure: createLocatorFailure({
        identity: options.capture.grid.identity,
        elementId: options.elementId,
        code: resolution.failure.code,
        message: resolution.failure.message,
      }),
    };
  }

  try {
    return {
      kind: 'success',
      grid: createCropCellGrid({ frame: options.capture.grid, locator: resolution.locator }),
      locator: resolution.locator,
    };
  } catch {
    return {
      kind: 'failure',
      failure: createLocatorFailure({
        identity: options.capture.grid.identity,
        elementId: options.elementId,
        code: 'invalid-locator-geometry',
        message: 'Crop locator does not resolve to a valid cell rectangle',
      }),
    };
  }
}

async function buildArtifact(options: {
  readonly grid: CellGrid;
  readonly locator: ResolvedElementLocator | null;
  readonly rasterize: PngRasterizer | undefined;
}): Promise<ArtifactBuildOutcome> {
  const grid = CellGridSchema.parse(options.grid);
  let truth: ReturnType<typeof serializeTerminalTruth>;
  try {
    truth = serializeTerminalTruth(grid);
  } catch {
    return {
      artifact: null,
      failures: [
        createArtifactFailure({
          stage: 'serialization',
          identity: grid.identity,
          code: 'terminal-serialization-failed',
          message: 'Terminal diagnostic serialization failed for the selected artifact',
        }),
      ],
    };
  }

  let svg: string;
  try {
    svg = renderCellGridSvg(grid);
  } catch {
    return buildWithoutDerived({ grid, locator: options.locator, truth });
  }

  const png = await renderCellGridPng({
    grid,
    svg,
    ...(options.rasterize === undefined ? {} : { rasterize: options.rasterize }),
  });
  const files = createArtifactFiles({
    identity: grid.identity,
    includeSvg: true,
    includePng: png.kind === 'success',
  });
  const record = createArtifactRecord({ grid, locator: options.locator, files });
  return {
    artifact: {
      record,
      files: [
        { relativePath: files.ansi, data: truth.ansi },
        { relativePath: files.txt, data: truth.txt },
        { relativePath: files.cells, data: truth.cellsJson },
        { relativePath: requirePath(files.svg), data: svg },
        ...(png.kind === 'success'
          ? [{ relativePath: requirePath(files.png), data: png.bytes }]
          : []),
      ],
    },
    failures: png.kind === 'success' ? [] : [png.failure],
  };
}

function buildWithoutDerived(options: {
  readonly grid: CellGrid;
  readonly locator: ResolvedElementLocator | null;
  readonly truth: ReturnType<typeof serializeTerminalTruth>;
}): ArtifactBuildOutcome {
  const files = createArtifactFiles({
    identity: options.grid.identity,
    includeSvg: false,
    includePng: false,
  });
  return {
    artifact: {
      record: createArtifactRecord({ grid: options.grid, locator: options.locator, files }),
      files: [
        { relativePath: files.ansi, data: options.truth.ansi },
        { relativePath: files.txt, data: options.truth.txt },
        { relativePath: files.cells, data: options.truth.cellsJson },
      ],
    },
    failures: [
      createArtifactFailure({
        stage: 'svg',
        identity: options.grid.identity,
        code: 'svg-render-failed',
        message: 'SVG rendering failed for the selected artifact',
      }),
      createArtifactFailure({
        stage: 'png',
        identity: options.grid.identity,
        code: 'png-source-unavailable',
        message: 'PNG rasterization requires the selected artifact SVG',
      }),
    ],
  };
}

function createArtifactRecord(options: {
  readonly grid: CellGrid;
  readonly locator: ResolvedElementLocator | null;
  readonly files: ArtifactRecord['files'];
}): ArtifactRecord {
  const { grid, locator, files } = options;
  return ArtifactRecordSchema.parse({
    identity: grid.identity,
    rect: grid.rect,
    dimensions: { cols: grid.rect.width, rows: grid.rect.height },
    files,
    locator:
      locator === null
        ? null
        : {
            kind: locator.kind,
            description: locator.description,
          },
  });
}

function createArtifactFailure(options: {
  readonly stage: 'serialization' | 'svg' | 'png';
  readonly identity: ArtifactIdentity;
  readonly code: string;
  readonly message: string;
}): Failure {
  return FailureSchema.parse({
    stage: options.stage,
    code: safeId(options.code),
    message: options.message,
    artifact: options.identity,
  });
}

function createLocatorFailure(options: {
  readonly identity: ArtifactIdentity;
  readonly elementId: CaptureTarget['elementIds'][number];
  readonly code: string;
  readonly message: string;
}): Failure {
  return FailureSchema.parse({
    stage: 'locator',
    code: safeId(options.code),
    message: options.message,
    provenance: options.identity.provenance,
    elementId: options.elementId,
    parentFrameKey: options.identity.key,
  });
}

function appendOutcome(
  outcome: ArtifactBuildOutcome,
  artifacts: PendingArtifact[],
  failures: Failure[],
): void {
  if (outcome.artifact !== null) artifacts.push(outcome.artifact);
  failures.push(...outcome.failures);
}

function requirePath(path: RelativeArtifactPath | null): RelativeArtifactPath {
  if (path === null) throw new Error('Required derived artifact path is unavailable');
  return path;
}
