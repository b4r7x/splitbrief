import {
  captureChangedFilesBaseline,
  changedFilesSinceBaseline,
  type ChangedFilesBaseline,
} from '../changed-files-baseline.js';
import { DIPTYCH_DIR } from '../../../core/paths.js';
import { error, matches } from '../../../utils/error.js';

export const planningMutationError = {
  unexpectedMutations: (files: string[]) =>
    error(
      'planning-unexpected-mutations',
      `CLI planner produced unexpected filesystem mutations: ${files.join(', ')}`,
      { files },
    ),
  isUnexpectedMutations: matches('planning-unexpected-mutations'),
} as const;

const BLOCKED_EXACT = new Set([
  '.npmrc',
  '.netrc',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
]);

const BLOCKED_PREFIXES = ['.git/', '.env', '.diptych/hooks/', '.diptych-sandbox/'];

export function isAllowedPlanningMutation(file: string, sessionId: string): boolean {
  const sessionPrefix = `${DIPTYCH_DIR}/sessions/${sessionId}/`;
  if (file.startsWith(sessionPrefix)) return true;
  if (file.startsWith(`${DIPTYCH_DIR}/`)) return false;
  if (BLOCKED_EXACT.has(file)) return false;
  for (const prefix of BLOCKED_PREFIXES) {
    if (file === prefix.slice(0, -1) || file.startsWith(prefix)) return false;
  }
  return false;
}

export async function capturePlanningMutationBaseline(
  projectDir: string,
): Promise<ChangedFilesBaseline> {
  return captureChangedFilesBaseline(projectDir);
}

export async function findUnexpectedPlanningMutations(opts: {
  projectDir: string;
  sessionId: string;
  baseline: ChangedFilesBaseline;
}): Promise<string[]> {
  const changed = await changedFilesSinceBaseline(opts.projectDir, opts.baseline);
  return changed.filter((file) => !isAllowedPlanningMutation(file, opts.sessionId));
}
