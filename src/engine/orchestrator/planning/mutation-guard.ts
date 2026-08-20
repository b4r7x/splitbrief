import {
  captureChangedFilesBaseline,
  changedFilesSinceBaseline,
  type ChangedFilesBaseline,
} from '../changed-files-baseline.js';
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

export async function capturePlanningMutationBaseline(
  projectDir: string,
): Promise<ChangedFilesBaseline> {
  return captureChangedFilesBaseline(projectDir);
}

// internalStatePaths are the tool's catalog-declared per-project state prefixes (e.g. OpenCode
// regenerates its `.opencode/package-lock.json` on startup); churn there is tool-internal
// housekeeping, not planner-authored content. No artifact basename or session path is exempt:
// the guard reports mutations and never selects a candidate artifact.
export async function findUnexpectedPlanningMutations(opts: {
  projectDir: string;
  baseline: ChangedFilesBaseline;
  internalStatePaths?: readonly string[] | undefined;
}): Promise<string[]> {
  const internalStatePaths = opts.internalStatePaths ?? [];
  const changed = await changedFilesSinceBaseline(opts.projectDir, opts.baseline);
  return changed.filter(
    (file) =>
      !internalStatePaths.some((path) =>
        path.endsWith('/') ? file.startsWith(path) : file === path,
      ),
  );
}
