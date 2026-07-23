import { chmod, lstat, rename, rm, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import type { ArtifactRecord } from '../contracts/artifacts.js';
import type { Failure } from '../contracts/failures.js';
import { ManifestSchema, serializeManifest, type Manifest } from '../contracts/manifest.js';
import type {
  DeterminismEnvelope,
  RendererMetadata,
  Warning,
} from '../contracts/manifest-fields.js';
import {
  CATALOG_SCHEMA_VERSION,
  CELL_GRID_SCHEMA_VERSION,
  MANIFEST_SCHEMA_VERSION,
} from '../contracts/schema-versions.js';
import { CaptureSelectionSchema, type CaptureSelection } from '../contracts/selection.js';
import { CONTROL_POLICY, HYPERLINK_POLICY } from '../terminal/controls.js';
import { MANIFEST_RELATIVE_PATH, createRunKey } from './layout.js';
import {
  preparePublicationLayout,
  publishPublicationLayout,
  createPublicationLayout,
  type PublicationLayout,
} from './publication.js';
import { resolveWritableContainedArtifactPath } from './confinement.js';

const MANIFEST_TEMP_RELATIVE_PATH = 'manifest.json.tmp';

export interface BuildManifestOptions {
  readonly toolVersion: string;
  readonly gitRevision: string | null;
  readonly selection: CaptureSelection;
  readonly determinism: DeterminismEnvelope;
  readonly renderer: RendererMetadata | null;
  readonly artifacts: readonly ArtifactRecord[];
  readonly warnings: readonly Warning[];
  readonly failures: readonly Failure[];
}

export interface PreparedArtifactPublication {
  readonly kind: 'prepared';
  readonly layout: PublicationLayout;
  readonly selection: CaptureSelection;
}

export interface ManifestedArtifactPublication {
  readonly kind: 'manifested';
  readonly layout: PublicationLayout;
  readonly manifest: Manifest;
}

export interface PublishedArtifactPublication {
  readonly kind: 'published';
  readonly runRoot: string;
  readonly manifestPath: string;
  readonly manifest: Manifest;
}

export function buildManifest(options: BuildManifestOptions): Manifest {
  return ManifestSchema.parse({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    catalogVersion: CATALOG_SCHEMA_VERSION,
    cellSchemaVersion: CELL_GRID_SCHEMA_VERSION,
    tool: {
      name: 'diptych-tui-shots',
      version: options.toolVersion,
    },
    gitRevision: options.gitRevision,
    selection: options.selection,
    determinism: options.determinism,
    controlPolicy: CONTROL_POLICY,
    hyperlinkPolicy: HYPERLINK_POLICY,
    renderer: options.renderer,
    artifacts: options.artifacts,
    warnings: options.warnings,
    failures: options.failures,
  });
}

export async function prepareArtifactPublication(options: {
  readonly outputRoot: string;
  readonly selection: CaptureSelection;
}): Promise<PreparedArtifactPublication> {
  const selection = CaptureSelectionSchema.parse(options.selection);
  const layout = createPublicationLayout({
    outputRoot: options.outputRoot,
    runKey: createRunKey(selection),
  });
  await preparePublicationLayout(layout);
  return { kind: 'prepared', layout, selection };
}

export async function stageArtifactManifest(
  publication: PreparedArtifactPublication,
  manifestInput: Manifest,
): Promise<ManifestedArtifactPublication> {
  const layout = validateLayout(publication.layout);
  const manifest = ManifestSchema.parse(manifestInput);
  if (createRunKey(manifest.selection) !== layout.runKey) {
    throw new Error('Manifest selection does not match its prepared publication namespace');
  }
  if (createRunKey(publication.selection) !== layout.runKey) {
    throw new Error('Prepared selection does not match its publication namespace');
  }
  if (!isDeepStrictEqual(manifest.selection, publication.selection)) {
    throw new Error('Manifest selection does not match the prepared capture selection');
  }
  await assertRealDirectory(layout.stagingRoot);
  await assertManifestFilesStaged({ layout, manifest });

  const manifestPath = await resolveWritableContainedArtifactPath({
    root: layout.stagingRoot,
    relativePath: MANIFEST_RELATIVE_PATH,
  });
  const tempPath = await resolveWritableContainedArtifactPath({
    root: layout.stagingRoot,
    relativePath: MANIFEST_TEMP_RELATIVE_PATH,
  });
  await rejectSymbolicLink(manifestPath);
  await rejectSymbolicLink(tempPath);
  await rm(tempPath, { force: true });
  try {
    await writeFile(tempPath, serializeManifest(manifest), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await rename(tempPath, manifestPath);
    await chmod(manifestPath, 0o600);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }

  return { kind: 'manifested', layout, manifest };
}

export async function publishArtifactPublication(
  publication: ManifestedArtifactPublication,
): Promise<PublishedArtifactPublication> {
  const layout = validateLayout(publication.layout);
  const stagedManifestPath = await resolveWritableContainedArtifactPath({
    root: layout.stagingRoot,
    relativePath: MANIFEST_RELATIVE_PATH,
  });
  const stats = await lstat(stagedManifestPath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error('Staged manifest must be a regular file');
  }

  await publishPublicationLayout(layout);
  const manifestPath = await resolveWritableContainedArtifactPath({
    root: layout.runRoot,
    relativePath: MANIFEST_RELATIVE_PATH,
  });
  return {
    kind: 'published',
    runRoot: layout.runRoot,
    manifestPath,
    manifest: publication.manifest,
  };
}

function validateLayout(layout: PublicationLayout): PublicationLayout {
  const expected = createPublicationLayout({
    outputRoot: layout.outputRoot,
    runKey: layout.runKey,
  });
  if (
    expected.runRoot !== layout.runRoot ||
    expected.stagingRoot !== layout.stagingRoot ||
    expected.previousRoot !== layout.previousRoot
  ) {
    throw new Error('Artifact publication layout is inconsistent');
  }
  return expected;
}

async function assertRealDirectory(path: string): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('Artifact staging root must be a real directory');
  }
}

async function rejectSymbolicLink(path: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) throw new Error('Manifest path cannot be a symbolic link');
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
}

async function assertManifestFilesStaged(options: {
  readonly layout: PublicationLayout;
  readonly manifest: Manifest;
}): Promise<void> {
  for (const artifact of options.manifest.artifacts) {
    const paths = [
      artifact.files.ansi,
      artifact.files.txt,
      artifact.files.cells,
      ...(artifact.files.svg === null ? [] : [artifact.files.svg]),
      ...(artifact.files.png === null ? [] : [artifact.files.png]),
    ];
    for (const relativePath of paths) {
      const path = await resolveWritableContainedArtifactPath({
        root: options.layout.stagingRoot,
        relativePath,
      });
      let stats: Awaited<ReturnType<typeof lstat>>;
      try {
        stats = await lstat(path);
      } catch (error) {
        if (isMissingPathError(error)) {
          throw new Error(`Staged artifact file is missing: ${relativePath}`);
        }
        throw error;
      }
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error(`Staged artifact is not a regular file: ${relativePath}`);
      }
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
