import type { ActionClass } from '../../../core/schemas/enums.js';
import type { ApprovalTier } from '../../../core/schemas/config.js';
import { SPLITBRIEF_DIR } from '../../../core/paths.js';
import { matchesGlob, scopePathPatterns } from '../../../utils/path-patterns.js';

export type TierMap = Partial<Record<ActionClass, ApprovalTier>>;

export type ClassifyInput = {
  actionDescription: string;
  taskFile: string;
  taskInBounds: string[];
  dependsOnFiles: string[];
  projectDir: string;
  allowedPaths?: string[] | undefined;
};

export type ClassifyResult = {
  actionClass: ActionClass;
  tier: ApprovalTier;
};

export const DEFAULT_TIER_MAP: Record<ActionClass, ApprovalTier> = {
  read: 'auto',
  write_in_scope: 'auto',
  validation: 'auto',
  write_out_of_scope: 'sticky',
  destructive: 'confirm',
  network: 'confirm',
  package_change: 'confirm',
};

function resolveTier(actionClass: ActionClass, overrides?: TierMap): ApprovalTier {
  return overrides?.[actionClass] ?? DEFAULT_TIER_MAP[actionClass];
}

const PACKAGE_MANIFEST_FILES = new Set([
  'bun.lock',
  'bun.lockb',
  'deno.json',
  'deno.lock',
  'package-lock.json',
  'package.json',
  'pipfile',
  'pipfile.lock',
  'pnpm-lock.yaml',
  'poetry.lock',
  'pyproject.toml',
  'requirements.txt',
  'yarn.lock',
]);

const WRITE_VERBS = [
  'write',
  'create',
  'edit',
  'modify',
  'update',
  'change',
  'patch',
  'apply diff',
];

const PATH_PREFIXES = ['src/', 'test/', 'tests/', 'docs/', './'];

function cleanToken(token: string): string {
  return token.replace(/^[`"'[{(]+/, '').replace(/[`"',:;\]})]+$/, '');
}

function normalizeProjectPath(filePath: string, projectDir: string): string {
  let normalized = filePath.replaceAll('\\', '/');
  const normalizedProjectDir = projectDir.replaceAll('\\', '/').replace(/\/+$/, '');
  if (normalized.startsWith(`${normalizedProjectDir}/`)) {
    normalized = normalized.slice(normalizedProjectDir.length + 1);
  }
  if (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

function hasPathLikeExtension(token: string): boolean {
  return /^[A-Za-z0-9_.@/-]+\.[A-Za-z0-9]+$/.test(token);
}

function isKnownPackagePath(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  const name = normalized.split('/').at(-1) ?? normalized;
  return PACKAGE_MANIFEST_FILES.has(name);
}

const CONTROL_PLANE_SEGMENTS = new Set(['.git', SPLITBRIEF_DIR]);

function isControlPlanePath(filePath: string): boolean {
  return CONTROL_PLANE_SEGMENTS.has(filePath.split('/')[0] ?? '');
}

function isPathLikeToken(token: string): boolean {
  const lower = token.toLowerCase();
  return (
    PATH_PREFIXES.some((prefix) => lower.startsWith(prefix)) ||
    token.startsWith('/') ||
    token.includes('/') ||
    hasPathLikeExtension(token) ||
    isKnownPackagePath(token)
  );
}

function extractPath(desc: string, input: ClassifyInput): string | null {
  const knownPaths = [input.taskFile, ...input.dependsOnFiles]
    .map((file) => normalizeProjectPath(file, input.projectDir))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const filePath of knownPaths) {
    if (desc.includes(filePath)) {
      return filePath;
    }
  }

  const tokens = desc.split(/\s+/).map(cleanToken);
  for (const token of tokens) {
    if (isPathLikeToken(token)) {
      return normalizeProjectPath(token, input.projectDir);
    }
  }
  return null;
}

function scopeEntryPatterns(entry: string): string[] {
  const patterns = scopePathPatterns(entry);
  if (patterns.length > 0) return patterns;
  // scopePathPatterns drops bare filenames (no separator or wildcard); a
  // whitespace-free entry is a literal pattern like `tsconfig.json`, not prose.
  const trimmed = entry.trim();
  return trimmed.length > 0 && !/\s/.test(trimmed) ? [trimmed] : [];
}

function isInScope(filePath: string, input: ClassifyInput): boolean {
  const normalized = normalizeProjectPath(filePath, input.projectDir);
  if (normalized === normalizeProjectPath(input.taskFile, input.projectDir)) return true;
  if (
    input.dependsOnFiles
      .map((file) => normalizeProjectPath(file, input.projectDir))
      .includes(normalized)
  )
    return true;
  if (
    input.taskInBounds
      .flatMap(scopeEntryPatterns)
      .some((pattern) => matchesGlob(normalized, normalizeProjectPath(pattern, input.projectDir)))
  )
    return true;
  if (input.allowedPaths?.some((glob) => matchesGlob(normalized, glob))) return true;
  return false;
}

export function extractActionPattern(input: ClassifyInput): string {
  const path = extractPath(input.actionDescription, input);
  return path ?? input.actionDescription;
}

export function matchesActionPattern(filePathOrAction: string, pattern: string): boolean {
  if (pattern === filePathOrAction) return true;
  return matchesGlob(filePathOrAction, pattern);
}

export function classifyAction(input: ClassifyInput, tierOverrides?: TierMap): ClassifyResult {
  const desc = input.actionDescription;
  const lower = desc.toLowerCase();

  const startsWithRead =
    !PATH_PREFIXES.some((p) => lower.startsWith(p)) &&
    ['read ', 'cat ', 'ls ', 'find ', 'grep '].some((p) => lower.startsWith(p));
  if (startsWithRead) {
    return { actionClass: 'read', tier: resolveTier('read', tierOverrides) };
  }

  const hasWriteVerb = WRITE_VERBS.some((v) => lower.includes(v));
  if (hasWriteVerb) {
    const targetPath = extractPath(desc, input);
    if (
      isControlPlanePath(normalizeProjectPath(input.taskFile, input.projectDir)) ||
      (targetPath !== null && isControlPlanePath(targetPath))
    ) {
      return { actionClass: 'destructive', tier: resolveTier('destructive', tierOverrides) };
    }
    if (targetPath !== null && isKnownPackagePath(targetPath)) {
      return { actionClass: 'package_change', tier: resolveTier('package_change', tierOverrides) };
    }
    if (targetPath !== null && isInScope(targetPath, input)) {
      return { actionClass: 'write_in_scope', tier: resolveTier('write_in_scope', tierOverrides) };
    }
    return {
      actionClass: 'write_out_of_scope',
      tier: resolveTier('write_out_of_scope', tierOverrides),
    };
  }

  // Escalation: no write verb and no other pattern means read to avoid false positives
  return { actionClass: 'read', tier: resolveTier('read', tierOverrides) };
}
