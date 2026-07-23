import { lstat, mkdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { SafeIdSchema, type SafeId } from '../contracts/identifiers.js';
import { resolveOutputRoot } from './confinement.js';

export interface PublicationLayout {
  readonly outputRoot: string;
  readonly runKey: SafeId;
  readonly runRoot: string;
  readonly stagingRoot: string;
  readonly previousRoot: string;
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

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
