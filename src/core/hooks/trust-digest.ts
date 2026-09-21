import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { assertExistingPathConfined } from '../../lib/path-confinement.js';
import { canonicalJSON } from '../../utils/canonical-json.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { sha256Hex } from '../../utils/sha256.js';
import { isRecord } from '../../utils/type-guards.js';
import { readPackageJson } from '../project-meta.js';
import { HookEventSchema, HooksConfigSchema } from '../schemas/hooks.js';
import {
  commandTokensAfterInterpreter,
  isBareCommandResolvedInsideProject,
  isPackageManagerScriptInvocation,
  isPathLike,
  isRepoLocal,
  resolveBareCommandOnPath,
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

const PACKAGE_SCRIPT_ALIASES = new Set(['start', 'stop', 'restart', 'test']);

function firstNonOptionIndex(tokens: readonly string[], start: number): number | null {
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined || token === '--') return null;
    if (token.startsWith('-') && token !== '-') continue;
    return i;
  }
  return null;
}

function packageManagerScriptName(tokens: readonly string[]): string | null {
  const subcommandIndex = firstNonOptionIndex(tokens, 1);
  if (subcommandIndex === null) return null;
  const subcommand = tokens[subcommandIndex] ?? '';
  if (subcommand === 'run' || subcommand === 'run-script') {
    const scriptIndex = firstNonOptionIndex(tokens, subcommandIndex + 1);
    return scriptIndex === null ? null : (tokens[scriptIndex] ?? null);
  }
  return PACKAGE_SCRIPT_ALIASES.has(subcommand) ? subcommand : null;
}

function repoLocalScriptPathsFromTokens(projectDir: string, tokens: readonly string[]): string[] {
  const checkTokens = commandTokensAfterInterpreter(tokens);
  const scripts: string[] = [];
  for (const token of checkTokens) {
    const candidate = token.startsWith('-') ? flagValue(token) : token;
    if (candidate === null) continue;
    if (isPathLike(candidate) && isRepoLocal(candidate, projectDir)) scripts.push(candidate);
  }
  return scripts;
}

function hashPackageJsonScript(projectDir: string, scriptName: string): HookFileDigest {
  const digestPath = `package.json#scripts/${scriptName}`;
  const pkg = readPackageJson(projectDir);
  if (pkg === null) {
    return { path: digestPath, error: 'package.json not found' };
  }
  const scripts = pkg['scripts'];
  if (!isRecord(scripts)) {
    return { path: digestPath, error: 'package.json scripts missing' };
  }
  const body = scripts[scriptName];
  if (typeof body !== 'string') {
    return { path: digestPath, error: 'package script not found' };
  }
  return {
    path: digestPath,
    sha256: sha256Hex(body),
  };
}

function commandHookTrustDigests(
  projectDir: string,
  command: string,
  args: string[],
): HookFileDigest[] {
  const tokens = [command, ...args].filter((token) => token.length > 0);
  const digests: HookFileDigest[] = [];

  const executable = tokens[0];
  if (executable && isBareCommandResolvedInsideProject(executable, projectDir)) {
    const resolved = resolveBareCommandOnPath(executable, projectDir);
    if (resolved !== null) {
      const relativePath = relative(projectDir, resolved);
      if (!relativePath.startsWith('..')) {
        digests.push(hashHookFile(projectDir, relativePath));
      }
    }
  }

  if (isPackageManagerScriptInvocation(tokens)) {
    const scriptName = packageManagerScriptName(tokens);
    if (scriptName !== null) {
      digests.push(hashPackageJsonScript(projectDir, scriptName));
    }
  }

  for (const scriptPath of repoLocalScriptPathsFromTokens(projectDir, tokens)) {
    digests.push(hashHookFile(projectDir, scriptPath));
  }

  return digests;
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

function hashHookFile(projectDir: string, relativePath: string): HookFileDigest {
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
    const content = readFileSync(filePath);
    return {
      path: relativePath,
      sha256: sha256Hex(content),
    };
  } catch (err) {
    return { path: relativePath, error: toErrorMessage(err) };
  }
}
