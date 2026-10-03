import { relative, resolve } from 'node:path';
import { type ActionClass, PROTECTED_ACTION_CLASSES } from '../../../core/schemas/enums.js';
import type { ApprovalTier } from '../../../core/approval/types.js';
import { SPLITBRIEF_DIR } from '../../../core/paths.js';
import { isInDeclaredSet } from '../../../core/scope/declared-set.js';
import { isInsideRoot, isPathConfined } from '../../../lib/path-confinement.js';
import { matchesGlob } from '../../../utils/path-patterns.js';

export type ClassifyInput = {
  actionDescription: string;
  /** The exact file being written; classification prefers it over the prose. */
  targetPath?: string | undefined;
  taskFiles: readonly string[];
  taskInBounds: readonly string[];
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
  write_out_of_scope: 'auto',
  destructive: 'confirm',
  network: 'confirm',
  package_change: 'confirm',
  sensitive_change: 'confirm',
};

const PACKAGE_MANIFEST_FILES = new Set([
  'bun.lock',
  'bun.lockb',
  'cargo.lock',
  'cargo.toml',
  'deno.json',
  'deno.lock',
  'go.mod',
  'go.sum',
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
  const normalized = filePath.replaceAll('\\', '/');
  const root = resolve(projectDir);
  const target = resolve(root, normalized);
  return isInsideRoot(root, target) ? relative(root, target) : normalized;
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

const CI_ROOT_SEGMENTS = new Set(['.github', '.circleci', '.buildkite']);

const SENSITIVE_FILE_NAMES = new Set([
  '.gitlab-ci.yml',
  'azure-pipelines.yml',
  'jenkinsfile',
  '.npmrc',
  '.pypirc',
]);

const SECRET_FILE_PATTERNS = ['.env', '.env.*', '*.pem', '*.key', 'id_rsa*'];

/** CI configuration and secret-bearing files. */
function isSensitivePath(filePath: string): boolean {
  const name = (filePath.split('/').at(-1) ?? filePath).toLowerCase();
  return (
    CI_ROOT_SEGMENTS.has(filePath.split('/')[0] ?? '') ||
    SENSITIVE_FILE_NAMES.has(name) ||
    SECRET_FILE_PATTERNS.some((pattern) => matchesGlob(name, pattern))
  );
}

export function isProtectedClass(actionClass: ActionClass): boolean {
  return PROTECTED_ACTION_CLASSES.includes(actionClass);
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

function targetPaths(input: ClassifyInput): string[] {
  const paths =
    input.targetPath !== undefined
      ? [input.targetPath]
      : input.actionDescription.split(/\s+/).map(cleanToken).filter(isPathLikeToken);
  return paths.map((path) => normalizeProjectPath(path, input.projectDir));
}

function isInScope(filePath: string, input: ClassifyInput): boolean {
  const normalized = normalizeProjectPath(filePath, input.projectDir);
  if (normalized === '' || !isPathConfined(normalized, input.projectDir)) return false;
  if (
    [...input.taskFiles, ...input.dependsOnFiles]
      .map((file) => normalizeProjectPath(file, input.projectDir))
      .includes(normalized)
  )
    return true;
  if (isInDeclaredSet(normalized, input.taskInBounds)) return true;
  if (input.allowedPaths?.some((glob) => matchesGlob(normalized, glob))) return true;
  return false;
}

export function classifyAction(input: ClassifyInput): ClassifyResult {
  const lower = input.actionDescription.toLowerCase();

  const startsWithRead =
    input.targetPath === undefined &&
    !PATH_PREFIXES.some((p) => lower.startsWith(p)) &&
    ['read ', 'cat ', 'ls ', 'find ', 'grep '].some((p) => lower.startsWith(p));
  if (startsWithRead) {
    return { actionClass: 'read', tier: DEFAULT_TIER_MAP.read };
  }

  const isWrite = input.targetPath !== undefined || WRITE_VERBS.some((v) => lower.includes(v));
  if (isWrite) {
    const paths = targetPaths(input);
    if (paths.some(isControlPlanePath)) {
      return { actionClass: 'destructive', tier: DEFAULT_TIER_MAP.destructive };
    }
    if (paths.some(isSensitivePath)) {
      return {
        actionClass: 'sensitive_change',
        tier: DEFAULT_TIER_MAP.sensitive_change,
      };
    }
    if (paths.some(isKnownPackagePath)) {
      return { actionClass: 'package_change', tier: DEFAULT_TIER_MAP.package_change };
    }
    if (paths.length > 0 && paths.every((path) => isInScope(path, input))) {
      return { actionClass: 'write_in_scope', tier: DEFAULT_TIER_MAP.write_in_scope };
    }
    return {
      actionClass: 'write_out_of_scope',
      tier: DEFAULT_TIER_MAP.write_out_of_scope,
    };
  }

  // No write verb and no other pattern: default to read rather than risk a false write classification.
  return { actionClass: 'read', tier: DEFAULT_TIER_MAP.read };
}

/** The protected ActionClass of a write of `path`, or null when that write asks for nothing. */
export function protectedWriteClass(path: string, projectDir: string): ActionClass | null {
  const { actionClass } = classifyAction({
    actionDescription: `write ${path}`,
    targetPath: path,
    taskFiles: [],
    taskInBounds: [],
    dependsOnFiles: [],
    projectDir,
  });
  return isProtectedClass(actionClass) ? actionClass : null;
}
