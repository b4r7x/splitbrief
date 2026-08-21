import { createHash } from 'node:crypto';
import { ArtifactIdentitySchema, type ArtifactIdentity } from '../contracts/artifact-identity.js';
import { ArtifactFilesSchema, type ArtifactFiles } from '../contracts/artifacts.js';
import { formatViewport } from '../contracts/geometry.js';
import {
  relativeArtifactPath,
  type RelativeArtifactPath,
  SafeIdSchema,
  type SafeId,
} from '../contracts/identifiers.js';
import { CATALOG_SCHEMA_VERSION } from '../contracts/schema-versions.js';
import { CaptureSelectionSchema, type CaptureSelection } from '../contracts/selection.js';
import { TerminalProfileSchema, type TerminalProfile } from '../contracts/manifest-fields.js';

export const DEFAULT_VISUAL_OUTPUT_ROOT = '.test-artifacts/ui';
export const MANIFEST_RELATIVE_PATH = relativeArtifactPath('manifest.json');

const DEFAULT_TERMINAL_PROFILE: TerminalProfile = 'unicode-color';

export interface ArtifactFilesOptions {
  readonly identity: ArtifactIdentity;
  readonly includeSvg: boolean;
  readonly includePng: boolean;
}

export function createRunKey(selectionInput: CaptureSelection): SafeId {
  const selection = CaptureSelectionSchema.parse(selectionInput);
  const canonicalSelection = {
    profile: terminalProfileOf(selection),
    requests: canonicalEntries(selection.requests),
    targets: canonicalEntries(selection.targets),
  };
  const digest = createHash('sha256')
    .update(JSON.stringify(canonicalSelection))
    .digest('hex')
    .slice(0, 20);
  return SafeIdSchema.parse(`catalog-${CATALOG_SCHEMA_VERSION}-${digest}`);
}

function terminalProfileOf(value: unknown): TerminalProfile {
  if (typeof value !== 'object' || value === null || !('profile' in value)) {
    return DEFAULT_TERMINAL_PROFILE;
  }
  const profile = value.profile;
  if (isTerminalProfile(profile)) return profile;
  throw new Error('Visual capture profile is invalid');
}

function isTerminalProfile(value: unknown): value is TerminalProfile {
  return TerminalProfileSchema.safeParse(value).success;
}

export function createArtifactFiles(options: ArtifactFilesOptions): ArtifactFiles {
  if (options.includePng && !options.includeSvg) {
    throw new Error('PNG artifact paths require the matching SVG artifact path');
  }
  const identity = ArtifactIdentitySchema.parse(options.identity);
  const stem = artifactStem(identity);
  return ArtifactFilesSchema.parse({
    ansi: relativeArtifactPath(`${stem}.ansi`),
    txt: relativeArtifactPath(`${stem}.txt`),
    cells: relativeArtifactPath(`${stem}.cells.json`),
    svg: options.includeSvg ? relativeArtifactPath(`${stem}.svg`) : null,
    png: options.includePng ? relativeArtifactPath(`${stem}.png`) : null,
  });
}

export function assertUniqueArtifactPaths(files: readonly ArtifactFiles[]): void {
  const seen = new Set<RelativeArtifactPath>();
  for (const fileSet of files) {
    const parsed = ArtifactFilesSchema.parse(fileSet);
    for (const path of artifactPaths(parsed)) {
      if (seen.has(path)) throw new Error(`Duplicate artifact path: ${path}`);
      seen.add(path);
    }
  }
}

function artifactStem(identity: ArtifactIdentity): RelativeArtifactPath {
  const { scenarioId, checkpointId, viewport } = identity.provenance;
  const captureRoot = `${scenarioId}/${formatViewport(viewport)}/${checkpointId}`;
  return identity.kind === 'frame'
    ? relativeArtifactPath(`${captureRoot}/frame`)
    : relativeArtifactPath(`${captureRoot}/elements/${identity.elementId}/crop`);
}

function artifactPaths(files: ArtifactFiles): readonly RelativeArtifactPath[] {
  return [
    files.ansi,
    files.txt,
    files.cells,
    ...(files.svg === null ? [] : [files.svg]),
    ...(files.png === null ? [] : [files.png]),
  ];
}

function canonicalEntries(
  entries: CaptureSelection['requests'] | CaptureSelection['targets'],
): readonly string[] {
  return entries
    .map(({ provenance, elementIds }) =>
      JSON.stringify([
        provenance.scenarioId,
        provenance.scenarioTitle,
        provenance.fixtureVersion,
        provenance.checkpointId,
        formatViewport(provenance.viewport),
        [...elementIds].sort(),
      ]),
    )
    .sort();
}
