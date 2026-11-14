import { lstatSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { isInsideRoot } from '../../lib/fs/confinement.js';
import { readPackageJson } from '../project-meta.js';

// Node's entry point is resolved as if it had been requested by require() from the working
// directory (nodejs.org/api/cli.html#program-entry-point): the exact path, then require's
// extension list, then a directory's package.json `main` and its index files.
const NODE_ENTRY_EXTENSIONS = ['.js', '.json', '.node'] as const;
const NODE_INDEX_FILES = ['index.js', 'index.json', 'index.node'] as const;

export type NodeEntryResolution =
  | { kind: 'file'; path: string }
  | { kind: 'symlink'; path: string }
  | { kind: 'escaped' }
  | { kind: 'missing' };

type EntryCandidateProbe = 'file' | 'symlink' | 'directory' | 'missing' | 'escaped';

function probeEntryCandidate(root: string, candidate: string): EntryCandidateProbe {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(candidate);
  } catch {
    return 'missing';
  }
  if (stats.isDirectory()) return 'directory';
  if (!stats.isFile() && !stats.isSymbolicLink()) return 'missing';
  if (!isInsideRoot(root, candidate)) return 'escaped';
  return stats.isSymbolicLink() ? 'symlink' : 'file';
}

function resolveCandidate(
  root: string,
  candidate: string,
  probe: EntryCandidateProbe,
): NodeEntryResolution {
  if (probe === 'escaped') return { kind: 'escaped' };
  return {
    kind: probe === 'symlink' ? 'symlink' : 'file',
    path: relative(root, candidate),
  };
}

function firstResolvedCandidate(
  root: string,
  candidates: readonly string[],
): NodeEntryResolution | null {
  for (const candidate of candidates) {
    const probe = probeEntryCandidate(root, candidate);
    if (probe === 'file' || probe === 'symlink' || probe === 'escaped') {
      return resolveCandidate(root, candidate, probe);
    }
  }
  return null;
}

// require() loads a `main` that names a directory through that directory's own index files
// (LOAD_INDEX(M)) before falling back to the package directory's index (LOAD_INDEX(X)).
function packageMainEntry(root: string, dir: string): NodeEntryResolution | null {
  const pkg = readPackageJson(dir);
  const main = pkg === null ? null : pkg['main'];
  if (typeof main !== 'string' || main.trim() === '') return null;
  const base = resolve(dir, main);
  return firstResolvedCandidate(root, [
    base,
    ...NODE_ENTRY_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...NODE_INDEX_FILES.map((name) => join(base, name)),
  ]);
}

/**
 * Resolves the file `node <operand>` runs. The operand must be lexically inside the project; an
 * escaping spelling keeps the constant confinement refusal the digest already records. A
 * candidate that exists but is a symlink is reported, never followed, and a candidate outside
 * the project is reported as escaped, never hashed. Resolution reads only metadata and
 * package.json through the regular-file-gated reader; no repository code runs.
 */
export function resolveNodeEntryPath(input: {
  projectDir: string;
  operand: string;
}): NodeEntryResolution | null {
  const root = resolve(input.projectDir);
  const base = resolve(root, input.operand);
  if (!isInsideRoot(root, base)) return null;

  const exact = probeEntryCandidate(root, base);
  if (exact === 'file' || exact === 'symlink' || exact === 'escaped') {
    return resolveCandidate(root, base, exact);
  }
  const byExtension = firstResolvedCandidate(
    root,
    NODE_ENTRY_EXTENSIONS.map((extension) => `${base}${extension}`),
  );
  if (byExtension !== null) return byExtension;
  if (exact !== 'directory') return { kind: 'missing' };

  const packageJson = join(base, 'package.json');
  const packageProbe = probeEntryCandidate(root, packageJson);
  if (packageProbe === 'symlink') return resolveCandidate(root, packageJson, packageProbe);
  if (packageProbe === 'file') {
    const byMain = packageMainEntry(root, base);
    if (byMain !== null) return byMain;
  }
  const byIndex = firstResolvedCandidate(
    root,
    NODE_INDEX_FILES.map((name) => join(base, name)),
  );
  return byIndex ?? { kind: 'missing' };
}
