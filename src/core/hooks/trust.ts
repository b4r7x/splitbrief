import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { writeSecureFile } from '../../lib/fs.js';
import { assertExistingPathConfined } from '../../lib/path-confinement.js';
import { canonicalJSON } from '../../utils/canonical-json.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { sha256Hex } from '../../utils/sha256.js';
import { isRecord } from '../../utils/type-guards.js';
import { HookEventSchema, HooksConfigSchema } from '../schemas/hooks.js';
import { readPackageJson } from '../project-meta.js';
import {
  commandTokensAfterInterpreter,
  isBareCommandResolvedInsideProject,
  isPackageManagerScriptInvocation,
  isPathLike,
  isRepoLocal,
  resolveBareCommandOnPath,
} from '../trust/path-classification.js';
import {
  TRUST_STORE_MAX_RECEIPTS,
  readTrustStore,
  resolveTrustStorePath,
  trustedProjectIdentity,
} from '../trust/receipt-store.js';

const HOOK_TRUST_FILE = 'hooks.json';
const HOOK_TRUST_VERSION = 1;

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const HookTrustReceiptSchema = z
  .strictObject({
    version: z.literal(HOOK_TRUST_VERSION),
    projectIdentity: DigestSchema,
    configDigest: DigestSchema,
    trustedAt: z.number().finite().nonnegative(),
  })
  .readonly();

const HookTrustFileSchema = z
  .strictObject({
    version: z.literal(HOOK_TRUST_VERSION),
    receipts: z.array(HookTrustReceiptSchema).max(TRUST_STORE_MAX_RECEIPTS),
  })
  .readonly();

type HookTrustFile = z.infer<typeof HookTrustFileSchema>;

type HookFileDigest = {
  path: string;
  sha256?: string;
  error?: string;
};

export function hashHooksConfig(projectDir: string, hooks: unknown): string {
  const json = canonicalJSON({
    hooks: hooks ?? null,
    moduleDigests: collectModuleDigests(projectDir, hooks),
    commandScriptDigests: collectCommandScriptDigests(projectDir, hooks),
  });
  return `sha256:${sha256Hex(json)}`;
}

const STATIC_IMPORT_RE = /\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_LOAD_RE = /\b(?:import|require)\s*\(\s*(['"])([^'"]*)\1\s*\)/g;
const DYNAMIC_LOAD_HEAD_RE = /\b(?:import|require)\s*\(/g;

const MODULE_EXTENSIONS = ['.js', '.ts', '.mjs', '.cjs', '.mts', '.cts'];

const UNRESOLVABLE_DYNAMIC_DEP = 'unresolvable dynamic dependency';

function isLocalModuleSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

type ModuleImports = {
  specifiers: string[];
  hasUnresolvableDynamicDep: boolean;
};

function parseStaticModuleImports(content: string): ModuleImports {
  const specifiers: string[] = [];
  for (const match of content.matchAll(STATIC_IMPORT_RE)) {
    const specifier = match[1];
    if (specifier && isLocalModuleSpecifier(specifier)) specifiers.push(specifier);
  }

  let literalDynamic = 0;
  for (const match of content.matchAll(DYNAMIC_LOAD_RE)) {
    literalDynamic += 1;
    const specifier = match[2];
    if (specifier && isLocalModuleSpecifier(specifier)) specifiers.push(specifier);
  }

  const totalDynamic = [...content.matchAll(DYNAMIC_LOAD_HEAD_RE)].length;
  return { specifiers, hasUnresolvableDynamicDep: totalDynamic > literalDynamic };
}

function resolveLocalModulePath(
  projectDir: string,
  fromRelativePath: string,
  specifier: string,
): string | null {
  const fromDir = dirname(resolve(projectDir, fromRelativePath));
  const base = resolve(fromDir, specifier);
  const candidates: string[] = [];

  if (specifier.endsWith('/')) {
    for (const modExt of MODULE_EXTENSIONS) {
      candidates.push(join(base, `index${modExt}`));
    }
  } else {
    candidates.push(base);
    if (extname(base).length === 0) {
      for (const modExt of MODULE_EXTENSIONS) {
        candidates.push(`${base}${modExt}`);
        candidates.push(join(base, `index${modExt}`));
      }
    }
  }

  for (const candidate of candidates) {
    try {
      const relativePath = relative(projectDir, candidate);
      if (relativePath.startsWith('..')) continue;
      assertExistingPathConfined(relativePath, projectDir);
      if (!existsSync(candidate)) continue;
      if (lstatSync(candidate).isSymbolicLink()) continue;
      return relativePath;
    } catch {
      // try next candidate
    }
  }
  return null;
}

type ModuleDependencies = {
  paths: string[];
  unresolvableDynamicDepPaths: string[];
};

function collectModuleDependencyPaths(projectDir: string, entryPath: string): ModuleDependencies {
  const visited = new Set<string>();
  const queue = [entryPath];
  const paths: string[] = [];
  const unresolvableDynamicDepPaths: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    paths.push(current);

    let content: string;
    try {
      assertExistingPathConfined(current, projectDir);
      const filePath = resolve(projectDir, current);
      if (!existsSync(filePath)) continue;
      const st = lstatSync(filePath);
      if (st.isSymbolicLink()) continue;
      content = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    const { specifiers, hasUnresolvableDynamicDep } = parseStaticModuleImports(content);
    if (hasUnresolvableDynamicDep) unresolvableDynamicDepPaths.push(current);
    for (const specifier of specifiers) {
      const resolved = resolveLocalModulePath(projectDir, current, specifier);
      if (resolved && !visited.has(resolved)) queue.push(resolved);
    }
  }

  return { paths, unresolvableDynamicDepPaths };
}

function collectModuleDigests(projectDir: string, hooks: unknown): HookFileDigest[] {
  const parsed = HooksConfigSchema.safeParse(hooks);
  if (!parsed.success) return [];

  const digests: HookFileDigest[] = [];
  const seen = new Set<string>();
  const flagged = new Set<string>();
  for (const event of HookEventSchema.options) {
    for (const entry of parsed.data[event] ?? []) {
      if (entry.kind !== 'module') continue;
      const { paths, unresolvableDynamicDepPaths } = collectModuleDependencyPaths(
        projectDir,
        entry.path,
      );
      for (const dependencyPath of paths) {
        if (seen.has(dependencyPath)) continue;
        seen.add(dependencyPath);
        digests.push(hashHookFile(projectDir, dependencyPath));
      }
      for (const dependencyPath of unresolvableDynamicDepPaths) {
        if (flagged.has(dependencyPath)) continue;
        flagged.add(dependencyPath);
        digests.push({ path: dependencyPath, error: UNRESOLVABLE_DYNAMIC_DEP });
      }
    }
  }
  return digests.toSorted((a, b) => a.path.localeCompare(b.path));
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

function parseHookTrustFile(value: unknown): HookTrustFile | null {
  const parsed = HookTrustFileSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * A grant is a fact about this machine and this checkout, so it is looked up in
 * the owner's trust store — never in the project. A repository that ships its
 * own receipt therefore grants itself nothing.
 */
export function isHooksConfigTrusted(projectDir: string, hooks: unknown): boolean {
  const identity = trustedProjectIdentity(projectDir);
  if (identity === null) return false;
  const read = readTrustStore(resolveTrustStorePath(HOOK_TRUST_FILE), parseHookTrustFile);
  if (read.kind !== 'value') return false;
  const receipt = read.value.receipts.find((candidate) => candidate.projectIdentity === identity);
  if (receipt === undefined) return false;
  return receipt.configDigest === hashHooksConfig(projectDir, hooks);
}

/**
 * Persisting the grant is best-effort in one direction only: an unresolvable
 * checkout or a store this process could not verify leaves no receipt, so the
 * next run asks again. Overwriting a store that failed verification would
 * discard whatever made it fail.
 */
export function markHooksConfigTrusted(projectDir: string, hooks: unknown): void {
  const identity = trustedProjectIdentity(projectDir);
  if (identity === null) return;
  const path = resolveTrustStorePath(HOOK_TRUST_FILE);
  const read = readTrustStore(path, parseHookTrustFile);
  if (read.kind === 'invalid') return;
  const existing = read.kind === 'value' ? read.value.receipts : [];
  const receipt = HookTrustReceiptSchema.parse({
    version: HOOK_TRUST_VERSION,
    projectIdentity: identity,
    configDigest: hashHooksConfig(projectDir, hooks),
    trustedAt: Date.now(),
  });
  const receipts = [
    ...existing.filter((candidate) => candidate.projectIdentity !== identity),
    receipt,
  ].slice(-TRUST_STORE_MAX_RECEIPTS);
  writeSecureFile(path, `${JSON.stringify({ version: HOOK_TRUST_VERSION, receipts }, null, 2)}\n`);
}
