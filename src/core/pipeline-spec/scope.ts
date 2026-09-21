export const SCOPE_RULE = {
  allowedSetText:
    "Allowed set = the brief's `files` + every path under **In bounds** and **Approved out of bounds** + the `files` of every brief already `done`",
  driftText:
    'Drift = the changed set minus the baseline set minus the allowed set, with the run directory excluded. Any path left over fails the attempt; the next attempt carries the revert instruction for those paths.',
  revertInstruction: (paths: readonly string[], declared: readonly string[]): string =>
    `Revert your changes to ${paths.join(', ')}; only ${declared.join(', ')} may change`,
} as const;
