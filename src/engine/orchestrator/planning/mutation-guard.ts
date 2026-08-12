import { basename } from 'node:path';
import {
  captureChangedFilesBaseline,
  changedFilesSinceBaseline,
  type ChangedFilesBaseline,
} from '../changed-files-baseline.js';
import { SPLITBRIEF_DIR } from '../../../core/paths.js';
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
  return file.startsWith(`${SPLITBRIEF_DIR}/sessions/${sessionId}/`);
}

export async function capturePlanningMutationBaseline(
  projectDir: string,
): Promise<ChangedFilesBaseline> {
  return captureChangedFilesBaseline(projectDir);
}

// artifactFile is the phase's declared artifact (e.g. tasks.md). A CLI planner that writes it
// anywhere inside the project is on the supported ingestion path readCliPhaseOutput reads back,
// so matching that basename is a produced artifact, not an unexpected project mutation.
// internalStatePaths are the tool's catalog-declared per-project state prefixes (e.g. OpenCode
// regenerates its `.opencode/package-lock.json` on startup); churn there is tool-internal
// housekeeping, not planner-authored content.
export async function findUnexpectedPlanningMutations(opts: {
  projectDir: string;
  sessionId: string;
  baseline: ChangedFilesBaseline;
  artifactFile?: string | undefined;
  internalStatePaths?: readonly string[] | undefined;
}): Promise<string[]> {
  const internalStatePaths = opts.internalStatePaths ?? [];
  const changed = await changedFilesSinceBaseline(opts.projectDir, opts.baseline);
  return changed.filter(
    (file) =>
      !isAllowedPlanningMutation(file, opts.sessionId) &&
      basename(file) !== opts.artifactFile &&
      !internalStatePaths.some((path) =>
        path.endsWith('/') ? file.startsWith(path) : file === path,
      ),
  );
}
