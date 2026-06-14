import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { writeSecureFile } from '../../lib/fs.js';
import { assertExistingPathConfined } from '../../lib/path-confinement.js';
import { canonicalJSON } from '../../utils/canonical-json.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { sha256Hex } from '../../utils/sha256.js';
import { getDiptychPath } from '../paths.js';
import { HookEventSchema, HooksConfigSchema } from '../schemas/hooks.js';
import {
  commandTokensAfterInterpreter,
  isPathLike,
  isRepoLocal,
} from '../trust/path-classification.js';

const TRUST_FILE = 'hook-trust.json';
const TRUST_VERSION = 1;

const TrustFileSchema = z.object({
  version: z.number(),
  trusted_hash: z.string(),
});
type TrustFile = z.infer<typeof TrustFileSchema>;

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

function commandHookScriptPaths(projectDir: string, command: string, args: string[]): string[] {
  const tokens = [command, ...args].filter((token) => token.length > 0);
  const checkTokens = commandTokensAfterInterpreter(tokens);
  const scripts: string[] = [];
  for (const token of checkTokens) {
    const candidate = token.startsWith('-') ? flagValue(token) : token;
    if (candidate === null) continue;
    if (isPathLike(candidate) && isRepoLocal(candidate, projectDir)) scripts.push(candidate);
  }
  return scripts;
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
      for (const scriptPath of commandHookScriptPaths(projectDir, entry.command, entry.args)) {
        if (seen.has(scriptPath)) continue;
        seen.add(scriptPath);
        digests.push(hashHookFile(projectDir, scriptPath));
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

function trustFilePath(projectDir: string): string {
  return getDiptychPath(projectDir, TRUST_FILE);
}

export function isHooksConfigTrusted(projectDir: string, hooks: unknown): boolean {
  const path = trustFilePath(projectDir);
  if (!existsSync(path)) return false;
  try {
    const result = TrustFileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (!result.success) return false;
    if (result.data.version !== TRUST_VERSION) return false;
    return result.data.trusted_hash === hashHooksConfig(projectDir, hooks);
  } catch {
    return false;
  }
}

export function markHooksConfigTrusted(projectDir: string, hooks: unknown): void {
  const file: TrustFile = {
    version: TRUST_VERSION,
    trusted_hash: hashHooksConfig(projectDir, hooks),
  };
  writeSecureFile(trustFilePath(projectDir), JSON.stringify(file, null, 2) + '\n');
}
