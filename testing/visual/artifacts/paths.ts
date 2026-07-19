import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, parse, relative, resolve } from 'node:path';
import { ArtifactIdentitySchema, type ArtifactIdentity } from '../contracts/artifact-identity.js';
import { ArtifactFilesSchema, type ArtifactFiles } from '../contracts/artifacts.js';
import { formatViewport } from '../contracts/geometry.js';
import {
  RelativeArtifactPathSchema,
  SafeIdSchema,
  relativeArtifactPath,
  type RelativeArtifactPath,
  type SafeId,
} from '../contracts/identifiers.js';
import { CATALOG_SCHEMA_VERSION } from '../contracts/schema-versions.js';
import { CaptureSelectionSchema, type CaptureSelection } from '../contracts/selection.js';

export const DEFAULT_VISUAL_OUTPUT_ROOT = '.test-artifacts/ui';
export const MANIFEST_RELATIVE_PATH = relativeArtifactPath('manifest.json');

export interface ArtifactFilesOptions {
  readonly identity: ArtifactIdentity;
  readonly includeSvg: boolean;
  readonly includePng: boolean;
}

export interface PublicationLayout {
  readonly outputRoot: string;
  readonly runKey: SafeId;
  readonly runRoot: string;
  readonly stagingRoot: string;
  readonly previousRoot: string;
}

export function createRunKey(selectionInput: CaptureSelection): SafeId {
  const selection = CaptureSelectionSchema.parse(selectionInput);
  const canonicalSelection = {
    requests: canonicalEntries(selection.requests),
    targets: canonicalEntries(selection.targets),
  };
  const digest = createHash('sha256')
    .update(JSON.stringify(canonicalSelection))
    .digest('hex')
    .slice(0, 20);
  return SafeIdSchema.parse(`catalog-${CATALOG_SCHEMA_VERSION}-${digest}`);
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

export function createPublicationLayout(options: {
  readonly outputRoot: string;
  readonly runKey: SafeId;
}): PublicationLayout {
  const outputRoot = resolveOutputRoot(options.outputRoot);
  const runKey = SafeIdSchema.parse(options.runKey);
  return {
    outputRoot,
    runKey,
    runRoot: resolveDirectChild(outputRoot, runKey),
    stagingRoot: resolveDirectChild(outputRoot, `${runKey}-staging`),
    previousRoot: resolveDirectChild(outputRoot, `${runKey}-previous`),
  };
}

export function resolveContainedArtifactPath(options: {
  readonly root: string;
  readonly relativePath: unknown;
}): string {
  const root = resolveOutputRoot(options.root);
  const relativePathValue = RelativeArtifactPathSchema.parse(options.relativePath);
  const target = resolve(root, relativePathValue);
  if (!isContainedPath({ root, target })) {
    throw new Error('Artifact path escapes its requested output root');
  }
  return target;
}

export async function resolveWritableContainedArtifactPath(options: {
  readonly root: string;
  readonly relativePath: unknown;
}): Promise<string> {
  const root = resolveOutputRoot(options.root);
  const target = resolveContainedArtifactPath(options);
  const realRoot = await realpath(root);

  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) throw new Error('Artifact path cannot be a symbolic link');
    const realTarget = await realpath(target);
    if (!isAtOrInside({ root: realRoot, target: realTarget })) {
      throw new Error('Artifact path resolves outside its requested output root');
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    const realParent = await nearestExistingRealDirectory(dirname(target));
    if (!isAtOrInside({ root: realRoot, target: realParent })) {
      throw new Error('Artifact parent resolves outside its requested output root');
    }
  }
  return target;
}

export async function preparePublicationLayout(layoutInput: PublicationLayout): Promise<void> {
  const layout = validatePublicationLayout(layoutInput);
  await mkdir(layout.outputRoot, { recursive: true, mode: 0o700 });
  await assertDirectoryIsNotSymlink(layout.outputRoot);
  await assertOwnedPathIsSafe(layout.runRoot, layout.outputRoot);
  await assertOwnedPathIsSafe(layout.stagingRoot, layout.outputRoot);
  await assertOwnedPathIsSafe(layout.previousRoot, layout.outputRoot);
  if (await pathExists(layout.previousRoot)) {
    if (await pathExists(layout.runRoot)) {
      await removeOwnedPath(layout.previousRoot, layout.outputRoot);
    } else {
      await rename(layout.previousRoot, layout.runRoot);
    }
  }
  await removeOwnedPath(layout.stagingRoot, layout.outputRoot);
  await mkdir(layout.stagingRoot, { mode: 0o700 });
}

export async function publishPublicationLayout(layoutInput: PublicationLayout): Promise<void> {
  const layout = validatePublicationLayout(layoutInput);
  await assertOwnedDirectory(layout.stagingRoot, layout.outputRoot);
  await assertOwnedPathIsSafe(layout.runRoot, layout.outputRoot);
  await assertOwnedPathIsSafe(layout.previousRoot, layout.outputRoot);

  const hadPreviousRun = await pathExists(layout.runRoot);
  if (hadPreviousRun) await rename(layout.runRoot, layout.previousRoot);
  try {
    await rename(layout.stagingRoot, layout.runRoot);
  } catch (error) {
    if (hadPreviousRun && !(await pathExists(layout.runRoot))) {
      await rename(layout.previousRoot, layout.runRoot);
    }
    throw error;
  }
  await removeOwnedPath(layout.previousRoot, layout.outputRoot);
}

export async function discardPublicationLayout(layoutInput: PublicationLayout): Promise<void> {
  const layout = validatePublicationLayout(layoutInput);
  await removeOwnedPath(layout.stagingRoot, layout.outputRoot);
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

function resolveOutputRoot(outputRoot: string): string {
  if (outputRoot.trim().length === 0 || outputRoot.includes('\0')) {
    throw new Error('Output root must be a non-empty filesystem path');
  }
  const resolved = resolve(outputRoot);
  if (resolved === parse(resolved).root) {
    throw new Error('Filesystem root cannot be used as the visual artifact output root');
  }
  return resolved;
}

function resolveDirectChild(root: string, name: string): string {
  const safeName = SafeIdSchema.parse(name);
  const target = resolve(root, safeName);
  if (relative(root, target) !== safeName) {
    throw new Error('Publication namespace is not a direct child of the output root');
  }
  return target;
}

function validatePublicationLayout(layout: PublicationLayout): PublicationLayout {
  const expected = createPublicationLayout({
    outputRoot: layout.outputRoot,
    runKey: layout.runKey,
  });
  if (
    expected.runRoot !== layout.runRoot ||
    expected.stagingRoot !== layout.stagingRoot ||
    expected.previousRoot !== layout.previousRoot
  ) {
    throw new Error('Publication layout paths do not match their output root and run key');
  }
  return expected;
}

async function assertDirectoryIsNotSymlink(path: string): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('Visual artifact output root must be a real directory');
  }
}

async function assertOwnedDirectory(path: string, root: string): Promise<void> {
  await assertOwnedPathIsSafe(path, root);
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('Publication staging path must be a real directory');
  }
}

async function assertOwnedPathIsSafe(path: string, root: string): Promise<void> {
  if (!isContainedPath({ root, target: path }) || resolve(dirname(path)) !== resolve(root)) {
    throw new Error('Publication path escapes its requested output root');
  }
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) throw new Error('Publication path cannot be a symbolic link');
    const realRoot = await realpath(root);
    const realTarget = await realpath(path);
    if (!isContainedPath({ root: realRoot, target: realTarget })) {
      throw new Error('Publication path resolves outside its requested output root');
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
}

async function removeOwnedPath(path: string, root: string): Promise<void> {
  await assertOwnedPathIsSafe(path, root);
  await rm(path, { recursive: true, force: true });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function isContainedPath(options: { readonly root: string; readonly target: string }): boolean {
  const relation = relative(options.root, options.target);
  return relation.length > 0 && !relation.startsWith('..') && !isAbsolute(relation);
}

function isAtOrInside(options: { readonly root: string; readonly target: string }): boolean {
  return options.root === options.target || isContainedPath(options);
}

async function nearestExistingRealDirectory(path: string): Promise<string> {
  let current = path;
  while (true) {
    try {
      return await realpath(current);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = dirname(current);
      if (parent === current) throw new Error('Artifact path has no existing confined ancestor');
      current = parent;
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
