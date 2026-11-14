import { realpathSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { sha256Hex } from '../../utils/sha256.js';
import { isRecord } from '../../utils/type-guards.js';
import { readPackageJson } from '../project-meta.js';
import { resolveNodeEntryPath } from '../trust/node-entry.js';
import { packageManagerScriptNames, scriptsRunFor } from '../trust/package-scripts.js';
import {
  commandTokensAfterInterpreter,
  isPathLike,
  isRepoLocal,
  interpreterOperands,
  isProjectFile,
  nodeEntryPointOperands,
  isBareCommandResolvedInsideProject,
} from '../trust/path-classification.js';
import { resolveBareCommandOnPath } from '../../lib/process/command-path.js';

export type HookFileDigest = {
  path: string;
  sha256?: string;
  error?: string;
};

type HookDigestPlan = {
  files: string[];
  entries: HookFileDigest[];
};

function repoLocalScriptPathsFromTokens(projectDir: string, tokens: readonly string[]): string[] {
  const checkTokens = commandTokensAfterInterpreter(tokens);
  const scripts: string[] = [];
  for (const token of checkTokens) {
    const candidate = token.startsWith('-') ? flagValue(token) : token;
    if (candidate === null) continue;
    if (isPathLike(candidate) && isRepoLocal(candidate, projectDir)) scripts.push(candidate);
  }
  // A hook runs in the project directory, so `node check.mjs` runs the file `node ./check.mjs`
  // runs.
  for (const token of interpreterOperands(tokens)) {
    const candidate = token.startsWith('-') ? flagValue(token) : token;
    if (candidate === null) continue;
    if (!isPathLike(candidate) && isProjectFile({ name: candidate, projectDir })) {
      scripts.push(candidate);
    }
  }
  return scripts;
}

function packageScriptPlan(projectDir: string, scriptName: string): HookDigestPlan {
  const digestPath = `package.json#scripts/${scriptName}`;
  const pkg = readPackageJson(projectDir);
  if (pkg === null) {
    return { files: [], entries: [{ path: digestPath, error: 'package.json not found' }] };
  }
  const scripts = pkg['scripts'];
  if (!isRecord(scripts)) {
    return {
      files: startDefaultFiles(scriptName, undefined),
      entries: [{ path: digestPath, error: 'package.json scripts missing' }],
    };
  }
  // The named script is recorded even when it is missing, and a script run around it only when
  // it exists, so a project that defines none keeps the digest its receipt holds.
  const entries = scriptsRunFor(scriptName).flatMap((name): HookFileDigest[] => {
    const body = scripts[name];
    if (typeof body === 'string') {
      return [{ path: `package.json#scripts/${name}`, sha256: sha256Hex(body) }];
    }
    return name === scriptName ? [{ path: digestPath, error: 'package script not found' }] : [];
  });
  return { files: startDefaultFiles(scriptName, scripts), entries };
}

// npm's documented default for `start` is `node server.js` when the project defines no start
// script; `restart` falls back to `start`, so the file the default runs is hashed like any
// other script target.
function startDefaultFiles(
  scriptName: string,
  scripts: Record<string, unknown> | undefined,
): string[] {
  if (!scriptsRunFor(scriptName).includes('start')) return [];
  return typeof scripts?.['start'] !== 'string' ? ['server.js'] : [];
}

export function commandHookPlan(
  projectDir: string,
  command: string,
  args: string[],
): HookDigestPlan {
  const tokens = [command, ...args].filter((token) => token.length > 0);
  const files: string[] = [];
  const entries: HookFileDigest[] = [];

  const executable = tokens[0];
  const executablePath = repoLocalExecutablePath(projectDir, executable);
  if (executablePath !== null) {
    files.push(executablePath);
  }

  for (const scriptName of packageManagerScriptNames(tokens)) {
    const plan = packageScriptPlan(projectDir, scriptName);
    files.push(...plan.files);
    entries.push(...plan.entries);
  }

  for (const scriptPath of repoLocalScriptPathsFromTokens(projectDir, tokens)) {
    if (scriptPath === executablePath) continue;
    files.push(scriptPath);
  }

  const nodePlan = nodeEntryPlan(projectDir, tokens);
  files.push(...nodePlan.files);
  entries.push(...nodePlan.entries);

  return { files, entries };
}

// Node runs a file the operand may not spell: `node check` runs `check.js`. Every candidate the
// existing scan treats as a hook file is resolved, and an operand that is already an existing
// regular file keeps its digest entry from that scan alone.
function nodeEntryPlan(projectDir: string, tokens: readonly string[]): HookDigestPlan {
  const files: string[] = [];
  const entries: HookFileDigest[] = [];
  for (const token of nodeEntryPointOperands(tokens)) {
    const operand = nodeEntryCandidate(projectDir, token);
    if (operand === null) continue;
    const resolution = resolveNodeEntryPath({ projectDir, operand });
    if (resolution === null) continue;
    if (resolution.kind === 'file' || resolution.kind === 'symlink') {
      files.push(resolution.path);
    } else if (resolution.kind === 'escaped') {
      entries.push({ path: operand, error: 'node entry point is outside the project' });
    } else {
      entries.push({ path: operand, error: 'node entry point not found' });
    }
  }
  return { files, entries };
}

function nodeEntryCandidate(projectDir: string, token: string): string | null {
  if (token.startsWith('-')) {
    const value = flagValue(token);
    if (value === null || !isPathLike(value) || !isRepoLocal(value, projectDir)) return null;
    return isProjectFile({ name: value, projectDir }) ? null : value;
  }
  if (isPathLike(token)) {
    if (!isRepoLocal(token, projectDir)) return null;
    // The existing scan records every path-like operand: an existing file is bound and a missing
    // or non-regular one keeps its constant refusal. Only an extensionless spelling can name a
    // different file at runtime, so only it is resolved here.
    if (extname(token) !== '') return null;
    return isProjectFile({ name: token, projectDir }) ? null : token;
  }
  return isProjectFile({ name: token, projectDir }) ? null : token;
}

// The command a hook runs is part of the trust surface. A bare command that PATH resolves inside
// the project and an explicit path-like command (`./nodemon check.mjs` runs the checkout's
// nodemon) are both hashed on their own, so interpreter operand filtering cannot hide the
// executable from the digest. A path the normalization refuses keeps its original spelling, so
// the digest pins the refusal instead of authorizing a different file.
function repoLocalExecutablePath(
  projectDir: string,
  executable: string | undefined,
): string | null {
  if (executable === undefined) return null;
  if (isBareCommandResolvedInsideProject(executable, projectDir)) {
    const resolved = resolveBareCommandOnPath(executable, projectDir);
    return resolved === null
      ? null
      : (repoRelativeHookPath({ projectDir, path: resolved }) ?? resolved);
  }
  return isPathLike(executable) && isRepoLocal(executable, projectDir)
    ? (repoRelativeHookPath({ projectDir, path: executable }) ?? executable)
    : null;
}

// The same project file has many spellings (`./tool`, `tool`, `/abs/project/tool`). The digest
// records the repo-relative one, so an absolute path inside the project is normalized before the
// confined read instead of freezing a confinement error, and a path that normalizes outside the
// project is refused so it cannot bind to an unrelated file.
//
// The kernel collapses `..` only after walking the symlink in front of it, so `link/../tool`
// runs a different file than the lexical spelling names. The parent is resolved the way the
// filesystem does (realpath) with the original final component re-attached, which keeps the
// kernel's target while leaving a final symlink visible to the lstat check.
export function repoRelativeHookPath(input: { projectDir: string; path: string }): string | null {
  const { projectDir, path } = input;
  const root = resolve(projectDir);
  const kernelTarget = filesystemTarget({ projectDir: root, path });
  const lexicalTarget = filesystemTarget({ projectDir: root, path: resolve(root, path) });
  if (kernelTarget !== lexicalTarget) {
    // The filesystem meaning and the lexical spelling disagree (a symlink before a `..`, or a
    // parent only one of them can see). Bind the digest to the kernel's target, and refuse a
    // target outside the project rather than hash a file the command does not run.
    return kernelTarget === null ? null : projectRelative({ projectDir, target: kernelTarget });
  }
  if (!isAbsolute(path)) return path;
  const relativePath = relative(root, path);
  return relativePath.startsWith('..') || isAbsolute(relativePath) ? null : relativePath;
}

// The file the kernel opens for `path`: every symlinked parent is resolved as the filesystem
// resolves it, then the original final component is re-attached so it is not followed here. The
// native realpath walks components left to right like the kernel; Node's portable fallback
// normalizes `..` lexically first, which is exactly the divergence this normalization removes.
function filesystemTarget(input: { projectDir: string; path: string }): string | null {
  const { projectDir, path } = input;
  const absolute = isAbsolute(path) ? path : `${projectDir}${sep}${path}`;
  try {
    return join(realpathSync.native(dirname(absolute)), basename(absolute));
  } catch {
    return null;
  }
}

function projectRelative(input: { projectDir: string; target: string }): string | null {
  const relativePath = relative(realpathOrResolve(input.projectDir), input.target);
  return relativePath.startsWith('..') || isAbsolute(relativePath) ? null : relativePath;
}

function realpathOrResolve(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function flagValue(token: string): string | null {
  const eq = token.indexOf('=');
  if (eq === -1) return null;
  const value = token.slice(eq + 1);
  return value.length > 0 ? value : null;
}
