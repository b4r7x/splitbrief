import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, parse, relative, resolve } from 'node:path';
import { RelativeArtifactPathSchema } from '../contracts/identifiers.js';

export function resolveOutputRoot(outputRoot: string): string {
  if (outputRoot.trim().length === 0 || outputRoot.includes('\0')) {
    throw new Error('Output root must be a non-empty filesystem path');
  }
  const resolved = resolve(outputRoot);
  if (resolved === parse(resolved).root) {
    throw new Error('Filesystem root cannot be used as the visual artifact output root');
  }
  return resolved;
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
