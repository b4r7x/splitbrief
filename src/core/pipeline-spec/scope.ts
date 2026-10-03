/** The paths whose writes always wait for the user to confirm them. */
export const PROTECTED_PATHS_TEXT =
  'dependency manifests and lockfiles, CI configuration, env and key files, `.git`, `.splitbrief`';

export const SCOPE_RULE = {
  allowedSetText:
    "Suggested set = the brief's `files` + every path under **In bounds** and **Approved out of bounds** + the `files` of every brief already `done`. It is guidance: the implementer may edit another ordinary project file when the change needs it, and names it with the reason",
  driftText: `Touched, not suggested = the changed set minus the baseline set minus the suggested set, with the run directory excluded. Each such path is recorded for the reviewer and its tests run; it never fails the attempt. Only a write to a protected path (${PROTECTED_PATHS_TEXT}) waits for the user to confirm it.`,
} as const;
