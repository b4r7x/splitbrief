import { FrameArtifactIdentitySchema, frameArtifactKey } from '../contracts/artifact-identity.js';
import { CellGridSchema } from '../contracts/cells.js';
import { FailureSchema, type Failure } from '../contracts/failures.js';
import { safeId, type RelativeArtifactPath } from '../contracts/identifiers.js';
import { PersistedDiagnosticTextSchema } from '../contracts/persisted-data.js';
import type { TerminalProfile, Warning } from '../contracts/manifest-fields.js';
import {
  CaptureSelectionSchema,
  captureAccountingKey,
  type ArtifactProvenance,
  type CaptureSelection,
  type CaptureTarget,
} from '../contracts/selection.js';
import { assertNever } from '../../../src/utils/type-guards.js';
import { findVisualScenario, listVisualScenarios } from '../catalog.js';
import { parseTerminalFrame } from '../terminal/parse.js';
import { writeArtifactBundle, type WriteArtifactBundleOptions } from '../artifacts/write.js';
import { writeStagedArtifactFile, type ArtifactFileWriter } from '../artifacts/staging.js';
import type { PngRasterizer } from '../artifacts/png.js';
import type { PublishedArtifactPublication } from '../artifacts/manifest.js';
import { inCaptureOrder, withCaptureEnvironment } from './environment.js';
import {
  mountGalleryScenario,
  type GalleryCaptureHandle,
  type MountGalleryScenarioOptions,
} from './mount.js';

export interface CaptureGalleryOptions {
  readonly outputRoot: string;
  readonly projectRoot: string;
  readonly toolVersion: string;
  readonly gitRevision: string | null;
  readonly selection: CaptureSelection;
  readonly warnings?: readonly Warning[];
  readonly failures?: readonly Failure[];
  readonly rasterize?: PngRasterizer;
  readonly writeArtifactFile?: ArtifactFileWriter;
  readonly mountScenario?: (options: MountGalleryScenarioOptions) => Promise<GalleryCaptureHandle>;
  readonly parseFrame?: typeof parseTerminalFrame;
}

interface CaptureAttempt {
  readonly capture: WriteArtifactBundleOptions['captures'][number] | null;
  readonly failure: Failure | null;
}

type CapturePhase = 'fixture' | 'checkpoint' | 'terminal';

const CaptureFailureMessageSchema = PersistedDiagnosticTextSchema.min(1).max(2_048);

export async function captureGallery(
  options: CaptureGalleryOptions,
): Promise<PublishedArtifactPublication> {
  const selection = CaptureSelectionSchema.parse(options.selection);
  const firstRequest = selection.requests[0];
  if (firstRequest === undefined) {
    throw new Error('Visual capture selection requires at least one request');
  }
  const profile = selection.profile;

  return withCaptureEnvironment(
    { viewport: firstRequest.provenance.viewport, profile },
    async ({ determinism }) => {
      const captures: WriteArtifactBundleOptions['captures'][number][] = [];
      const failures: Failure[] = [...(options.failures ?? [])];
      const targets = orderedTargets(selection.targets);

      for (const target of targets) {
        const attempt = await captureTarget({
          target,
          projectRoot: options.projectRoot,
          profile,
          mountScenario: options.mountScenario ?? mountGalleryScenario,
          parseFrame: options.parseFrame ?? parseTerminalFrame,
        });
        if (attempt.capture !== null) captures.push(attempt.capture);
        if (attempt.failure !== null) failures.push(attempt.failure);
      }

      let activeWritePath: RelativeArtifactPath | null = null;
      const writer = options.writeArtifactFile ?? writeStagedArtifactFile;
      try {
        return await writeArtifactBundle({
          outputRoot: options.outputRoot,
          toolVersion: options.toolVersion,
          gitRevision: options.gitRevision,
          selection,
          determinism,
          captures,
          warnings: options.warnings ?? [],
          failures,
          ...(options.rasterize === undefined ? {} : { rasterize: options.rasterize }),
          writeArtifactFile: async (file) => {
            activeWritePath = file.relativePath;
            await writer(file);
          },
        });
      } catch (error) {
        const selectionIdentity =
          activeWritePath ??
          captureAccountingKey(targets[0]?.provenance ?? firstRequest.provenance);
        throw new Error(`Visual capture publication failed while handling ${selectionIdentity}`, {
          cause: error,
        });
      }
    },
  );
}

function orderedTargets(targets: readonly CaptureTarget[]): readonly CaptureTarget[] {
  const catalogOrder = new Map(
    listVisualScenarios().map((scenario, index) => [scenario.id, index]),
  );
  return inCaptureOrder(targets, (target) => {
    const scenario = findVisualScenario(target.provenance.scenarioId);
    const scenarioIndex = catalogOrder.get(target.provenance.scenarioId) ?? Number.MAX_SAFE_INTEGER;
    const checkpointIndex =
      scenario?.checkpoints.findIndex(
        (checkpoint) => checkpoint.id === target.provenance.checkpointId,
      ) ?? -1;
    const viewportIndex =
      scenario?.viewports.findIndex(
        (viewport) =>
          viewport.cols === target.provenance.viewport.cols &&
          viewport.rows === target.provenance.viewport.rows,
      ) ?? -1;
    return [
      sortableIndex(scenarioIndex),
      sortableIndex(checkpointIndex),
      sortableIndex(viewportIndex),
      captureAccountingKey(target.provenance),
    ].join(':');
  });
}

async function captureTarget(options: {
  readonly target: CaptureTarget;
  readonly projectRoot: string;
  readonly profile: TerminalProfile;
  readonly mountScenario: (options: MountGalleryScenarioOptions) => Promise<GalleryCaptureHandle>;
  readonly parseFrame: typeof parseTerminalFrame;
}): Promise<CaptureAttempt> {
  const { target } = options;
  let phase: CapturePhase = 'fixture';
  let handle: GalleryCaptureHandle | undefined;
  let capture: CaptureAttempt['capture'] = null;
  let failure: Failure | null = null;

  try {
    const scenario = findVisualScenario(target.provenance.scenarioId);
    const checkpoint = scenario?.checkpoints.find(
      (candidate) => candidate.id === target.provenance.checkpointId,
    );
    if (
      scenario === undefined ||
      checkpoint === undefined ||
      scenario.title !== target.provenance.scenarioTitle ||
      scenario.fixtureVersion !== target.provenance.fixtureVersion
    ) {
      throw new Error('Selected capture does not resolve to its catalog scenario and checkpoint');
    }

    handle = await options.mountScenario({
      scenario,
      checkpoint,
      viewport: target.provenance.viewport,
      profile: options.profile,
    });
    phase = 'checkpoint';
    const ansi = await handle.waitForCheckpoint();
    phase = 'terminal';
    const identity = FrameArtifactIdentitySchema.parse({
      kind: 'frame',
      key: frameArtifactKey(target.provenance),
      provenance: target.provenance,
      elementId: null,
      parentFrameKey: null,
    });
    const grid = CellGridSchema.parse(
      await options.parseFrame({
        ansi,
        identity,
        projectRoot: options.projectRoot,
      }),
    );
    if (grid.identity.key !== identity.key) {
      throw new Error('Parsed terminal frame does not match its selected capture identity');
    }
    capture = { scenario, checkpoint, grid };
  } catch (error) {
    failure = createCaptureFailure({
      stage: phase,
      provenance: target.provenance,
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (handle !== undefined) {
      try {
        await handle.unmount();
      } catch {
        capture = null;
        if (failure === null) failure = createCleanupFailure(target.provenance);
      }
    }
  }

  return { capture, failure };
}

function createCaptureFailure(options: {
  readonly stage: CapturePhase;
  readonly provenance: ArtifactProvenance;
  readonly detail?: string;
}): Failure {
  const fields = {
    stage: options.stage,
    code: safeId(`${options.stage}-capture-failed`),
    message: captureFailureMessage(options.stage, options.detail),
    provenance: options.provenance,
  };
  return FailureSchema.parse(fields);
}

function createCleanupFailure(provenance: ArtifactProvenance): Failure {
  return FailureSchema.parse({
    stage: 'cleanup',
    code: safeId('capture-cleanup-failed'),
    message: 'Capture cleanup failed for the selected scenario and viewport',
    target: { kind: 'capture', provenance },
  });
}

function captureFailureMessage(stage: CapturePhase, detail?: string): string {
  const base = captureStageMessage(stage);
  if (detail === undefined || detail.length === 0) return base;
  const candidate = `${base}: ${detail}`.slice(0, 2_048);
  const parsed = CaptureFailureMessageSchema.safeParse(candidate);
  return parsed.success ? parsed.data : base;
}

function captureStageMessage(stage: CapturePhase): string {
  switch (stage) {
    case 'fixture':
      return 'Fixture mount failed for the selected scenario and viewport';
    case 'checkpoint':
      return 'Checkpoint was not reached for the selected scenario and viewport';
    case 'terminal':
      return 'Terminal parsing failed for the selected scenario and viewport';
    default:
      return assertNever(stage);
  }
}

function sortableIndex(index: number): string {
  return String(index < 0 ? Number.MAX_SAFE_INTEGER : index).padStart(16, '0');
}
