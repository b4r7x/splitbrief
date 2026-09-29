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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
  packageManagerScriptNames,
  resolveBareCommandOnPath,
  scriptsRunFor,
} from '../trust/path-classification.js';

type HookFileDigest = {
  path: string;
  sha256?: string;
  error?: string;
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

function hashPackageJsonScripts(projectDir: string, scriptName: string): HookFileDigest[] {
  const digestPath = `package.json#scripts/${scriptName}`;
  const pkg = readPackageJson(projectDir);
  if (pkg === null) {
    return [{ path: digestPath, error: 'package.json not found' }];
  }
  const scripts = pkg['scripts'];
  if (!isRecord(scripts)) {
    return [{ path: digestPath, error: 'package.json scripts missing' }];
  }
  // The named script is recorded even when it is missing, and a script run around it only when
  // it exists, so a project that defines none keeps the digest its receipt holds.
  return scriptsRunFor(scriptName).flatMap((name): HookFileDigest[] => {
    const body = scripts[name];
    if (typeof body === 'string') {
      return [{ path: `package.json#scripts/${name}`, sha256: sha256Hex(body) }];
    }
    return name === scriptName ? [{ path: digestPath, error: 'package script not found' }] : [];
  });
}

function commandHookTrustDigests(
  projectDir: string,
  command: string,
  args: string[],
): HookFileDigest[] {
  const tokens = [command, ...args].filter((token) => token.length > 0);
  const digests: HookFileDigest[] = [];

  const executable = tokens[0];
  const executablePath = repoLocalExecutablePath(projectDir, executable);
  if (executablePath !== null) {
    digests.push(hashHookFile(projectDir, executablePath));
  }

  for (const scriptName of packageManagerScriptNames(tokens)) {
    digests.push(...hashPackageJsonScripts(projectDir, scriptName));
  }

  for (const scriptPath of repoLocalScriptPathsFromTokens(projectDir, tokens)) {
    if (scriptPath === executablePath) continue;
    digests.push(hashHookFile(projectDir, scriptPath));
  }

  return digests;
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
      for (const digest of commandHookTrustDigests(projectDir, entry.command, entry.args)) {
        if (seen.has(digest.path)) continue;
        seen.add(digest.path);
        digests.push(digest);
      }
    }
  }
  return digests.toSorted((a, b) => a.path.localeCompare(b.path));
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
