import type { ActionClass } from '../../../core/schemas/enums.js';
import type { ApprovalTier } from '../../../core/schemas/config.js';

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

const DESTRUCTIVE_PATTERNS = [
  'rm -rf',
  'rm -r',
  'git reset --hard',
  'git clean -f',
  'git push --force',
  'git push -f',
  'git branch -d',
  // database migration commands — irreversible side effects on persistent data
  'prisma migrate deploy',
  'prisma migrate reset',
  'prisma db push',
  'drizzle-kit push',
  'drizzle-kit migrate',
  'knex migrate',
  'knex migrate:latest',
  'knex migrate:up',
  'knex migrate:rollback',
  'sequelize db:migrate',
  'sequelize-cli db:migrate',
  'alembic upgrade',
  'alembic downgrade',
  'rails db:migrate',
  'rake db:migrate',
];

const NETWORK_PATTERNS = ['curl ', 'wget ', 'fetch(', 'npm publish', 'http://', 'https://'];

const PACKAGE_CHANGE_PATTERNS = [
  'npm install',
  'npm uninstall',
  'npm remove',
  'npm rm',
  'npm update',
  'npm i ',
  'pip install',
  'pip uninstall',
  'yarn add',
  'yarn install',
  'yarn upgrade',
  'yarn remove',
  'pnpm add',
  'pnpm install',
  'pnpm i ',
  'pnpm remove',
  'pnpm rm',
  'pnpm update',
  'pnpm up',
  'bun add',
  'bun install',
  'bun remove',
];

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

const VALIDATION_PATTERNS = [
  'tsc',
  'eslint',
  'biome check',
  'vitest',
  'npm test',
  'npm run test',
  'npm run typecheck',
  'npm run lint',
];

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

function hasPattern(desc: string, patterns: string[]): boolean {
  const lower = desc.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

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

function matchesGlob(filePath: string, pattern: string): boolean {
  if (pattern === filePath) return true;

  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return filePath.startsWith(prefix + '/') || filePath === prefix;
  }

  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -2);
    const rest = filePath.slice(prefix.length + 1);
    return filePath.startsWith(prefix + '/') && !rest.includes('/');
  }

  if (pattern.startsWith('*.')) {
    const ext = pattern.slice(1);
    return filePath.endsWith(ext);
  }

  if (pattern.includes('*')) {
    const starIdx = pattern.indexOf('*');
    const beforeStar = pattern.slice(0, starIdx);
    const afterStar = pattern.slice(starIdx + 1);
    return filePath.startsWith(beforeStar) && (afterStar === '' || filePath.endsWith(afterStar));
  }

  return false;
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
    input.taskInBounds.some((glob) =>
      matchesGlob(normalized, normalizeProjectPath(glob, input.projectDir)),
    )
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

  if (hasPattern(desc, DESTRUCTIVE_PATTERNS)) {
    return { actionClass: 'destructive', tier: resolveTier('destructive', tierOverrides) };
  }

  if (hasPattern(desc, NETWORK_PATTERNS)) {
    return { actionClass: 'network', tier: resolveTier('network', tierOverrides) };
  }

  if (hasPattern(desc, PACKAGE_CHANGE_PATTERNS)) {
    return { actionClass: 'package_change', tier: resolveTier('package_change', tierOverrides) };
  }

  if (hasPattern(desc, VALIDATION_PATTERNS)) {
    return { actionClass: 'validation', tier: resolveTier('validation', tierOverrides) };
  }

  const lower = desc.toLowerCase();

  const startsWithRead =
    PATH_PREFIXES.some((p) => lower.startsWith(p)) === false &&
    ['read ', 'cat ', 'ls ', 'find ', 'grep '].some((p) => lower.startsWith(p));
  if (startsWithRead) {
    return { actionClass: 'read', tier: resolveTier('read', tierOverrides) };
  }

  const hasWriteVerb = WRITE_VERBS.some((v) => lower.includes(v));
  if (hasWriteVerb) {
    const targetPath = extractPath(desc, input);
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

  // Escalation: no write verb and no other pattern → read to avoid false positives
  return { actionClass: 'read', tier: resolveTier('read', tierOverrides) };
}
