import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertExistingPathConfined } from '../../lib/path-confinement.js';
import { canonicalJSON } from '../../utils/canonical-json.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { sha256Hex } from '../../utils/sha256.js';
import { isRecord } from '../../utils/type-guards.js';
import { readPackageJson } from '../project-meta.js';
import { HookEventSchema, HooksConfigSchema } from '../schemas/hooks.js';
import {
  commandTokensAfterInterpreter,
  interpreterOperands,
  isBareCommandResolvedInsideProject,
  isPathLike,
  isProjectFile,
  isRepoLocal,
  nodeEntryPointOperands,
  packageManagerScriptNames,
  resolveBareCommandOnPath,
  resolveNodeEntryPath,
  scriptsRunFor,
} from '../trust/path-classification.js';

type HookFileDigest = {
  path: string;
  sha256?: string;
  error?: string;
};

type HookDigestPlan = {
  files: string[];
  entries: HookFileDigest[];
};

export function hashHooksConfig(projectDir: string, hooks: unknown): string {
  const json = canonicalJSON({
    hooks: hooks ?? null,
    commandScriptDigests: collectCommandScriptDigests(projectDir, hooks),
  });
  return `sha256:${sha256Hex(json)}`;
}

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

function commandHookPlan(projectDir: string, command: string, args: string[]): HookDigestPlan {
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
function repoRelativeHookPath(input: { projectDir: string; path: string }): string | null {
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

function collectCommandScriptDigests(projectDir: string, hooks: unknown): HookFileDigest[] {
  const parsed = HooksConfigSchema.safeParse(hooks);
  if (!parsed.success) return [];

  const digests: HookFileDigest[] = [];
  const seen = new Set<string>();
  for (const event of HookEventSchema.options) {
    for (const entry of parsed.data[event] ?? []) {
      if (entry.kind !== 'command') continue;
      const plan = commandHookPlan(projectDir, entry.command, entry.args);
      const candidates = [
        ...plan.files.map((file) => hashHookFile(projectDir, file)),
        ...plan.entries,
      ];
      for (const digest of candidates) {
        if (seen.has(digest.path)) continue;
        seen.add(digest.path);
        digests.push(digest);
      }
    }
  }
  return digests.toSorted((a, b) => a.path.localeCompare(b.path));
}

export type IneligibleHookTarget = {
  path: string;
  reason: string;
};

/**
 * A target the digest refuses to bind is not the same as a changed digest: dispatch runs the
 * command even when its digest entry is a refusal, so a receipt that recorded the refusal could
 * keep authorizing bytes the digest never saw when the target changes. Trust is withheld instead,
 * and no receipt is written.
 */
export function findIneligibleHookTarget(
  projectDir: string,
  hooks: unknown,
): IneligibleHookTarget | null {
  const parsed = HooksConfigSchema.safeParse(hooks);
  if (!parsed.success) return null;
  for (const event of HookEventSchema.options) {
    for (const entry of parsed.data[event] ?? []) {
      if (entry.kind !== 'command') continue;
      for (const file of commandHookPlan(projectDir, entry.command, entry.args).files) {
        const symlinkPath = symlinkedHookFile(projectDir, file);
        if (symlinkPath !== null) {
          return { path: symlinkPath, reason: 'symlink hook script' };
        }
      }
    }
  }
  return null;
}

function symlinkedHookFile(projectDir: string, hookPath: string): string | null {
  const relativePath = repoRelativeHookPath({ projectDir, path: hookPath });
  if (relativePath === null) return null;
  try {
    return lstatSync(resolve(projectDir, relativePath)).isSymbolicLink() ? relativePath : null;
  } catch {
    return null;
  }
}

function hashHookFile(projectDir: string, hookPath: string): HookFileDigest {
  const relativePath = repoRelativeHookPath({ projectDir, path: hookPath });
  if (relativePath === null) {
    return { path: hookPath, error: 'hook file path is not a confined project path' };
  }
  try {
    assertExistingPathConfined(relativePath, projectDir);
    const filePath = resolve(projectDir, relativePath);
    if (!existsSync(filePath)) {
      return { path: relativePath, error: 'file not found' };
    }
    const st = lstatSync(filePath);
    if (st.isSymbolicLink()) {
      return { path: relativePath, error: 'symlink hook script' };
    }
    // A FIFO read waits for a writer that may never come; a socket or device is no script.
    if (st.isFIFO() || st.isSocket() || st.isCharacterDevice() || st.isBlockDevice()) {
      return { path: relativePath, error: 'not a regular file' };
    }
    // The path can be swapped between the checks above and the read below, so open without
    // following symlinks and without blocking on a FIFO, then verify the opened descriptor is the
    // same regular file the lstat saw before reading the descriptor itself.
    let fd: number | null = null;
    try {
      fd = openSync(
        filePath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      const opened = fstatSync(fd);
      if (!opened.isFile()) {
        return { path: relativePath, error: 'not a regular file' };
      }
      if (opened.dev !== st.dev || opened.ino !== st.ino) {
        return { path: relativePath, error: 'file replaced during hashing' };
      }
      const content = readFileSync(fd);
      return {
        path: relativePath,
        sha256: sha256Hex(content),
      };
    } finally {
      if (fd !== null) closeSync(fd);
    }
  } catch (err) {
    return { path: relativePath, error: toErrorMessage(err) };
  }
}
