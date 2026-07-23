import { CaptureSelectionSchema, type CaptureSelection } from '../contracts/selection.js';
import type { DeterminismEnvelope, Warning } from '../contracts/manifest-fields.js';
import type { Failure } from '../contracts/failures.js';
import {
  buildManifest,
  prepareArtifactPublication,
  publishArtifactPublication,
  stageArtifactManifest,
  type PublishedArtifactPublication,
} from './manifest.js';
import { createRunKey } from './layout.js';
import { createPublicationLayout, discardPublicationLayout } from './publication.js';
import type { PngRasterizer } from './png.js';
import {
  buildRunArtifacts,
  pngRendererMetadataForArtifacts,
  type VisualFrameCapture,
} from './build.js';
import {
  verifyStagedArtifact,
  writeStagedArtifactFile,
  type ArtifactFileWriter,
} from './staging.js';

export interface WriteArtifactBundleOptions {
  readonly outputRoot: string;
  readonly toolVersion: string;
  readonly gitRevision: string | null;
  readonly selection: CaptureSelection;
  readonly determinism: DeterminismEnvelope;
  readonly captures: readonly VisualFrameCapture[];
  readonly warnings?: readonly Warning[];
  readonly failures?: readonly Failure[];
  readonly rasterize?: PngRasterizer;
  readonly writeArtifactFile?: ArtifactFileWriter;
}

export async function writeArtifactBundle(
  options: WriteArtifactBundleOptions,
): Promise<PublishedArtifactPublication> {
  const selection = CaptureSelectionSchema.parse(options.selection);
  const layout = createPublicationLayout({
    outputRoot: options.outputRoot,
    runKey: createRunKey(selection),
  });

  try {
    const publication = await prepareArtifactPublication({
      outputRoot: options.outputRoot,
      selection,
    });
    const run = await buildRunArtifacts({
      captures: options.captures,
      selection,
      rasterize: options.rasterize,
      initialFailures: options.failures ?? [],
    });

    const writer = options.writeArtifactFile ?? writeStagedArtifactFile;
    for (const artifact of run.artifacts) {
      for (const file of artifact.files) {
        await writer({ ...file, root: publication.layout.stagingRoot });
      }
      await verifyStagedArtifact({
        root: publication.layout.stagingRoot,
        files: artifact.files,
      });
    }

    const artifactRecords = run.artifacts.map((artifact) => artifact.record);
    const manifest = buildManifest({
      toolVersion: options.toolVersion,
      gitRevision: options.gitRevision,
      selection,
      determinism: options.determinism,
      renderer: pngRendererMetadataForArtifacts(artifactRecords),
      artifacts: artifactRecords,
      warnings: options.warnings ?? [],
      failures: run.failures,
    });
    const manifested = await stageArtifactManifest(publication, manifest);
    return await publishArtifactPublication(manifested);
  } catch {
    await discardPublicationLayout(layout);
    throw new Error('Visual artifact bundle publication failed');
  }
}
