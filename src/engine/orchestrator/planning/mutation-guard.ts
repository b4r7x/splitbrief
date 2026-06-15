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

export function isAllowedPlanningMutation(file: string, sessionId: string): boolean {
  return file.startsWith(`${DIPTYCH_DIR}/sessions/${sessionId}/`);
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
