import { pairFailureKeys } from '../review/fix-task.js';

/** A failure as two judgements compare it: each failing source with its failure keys. */
export type FailureMark = readonly { source: string; keys: readonly string[] }[];

/** Same sources, and each source's keys pair fully: a diagnostic that only moved its line is the same failure. */
export function sameFailure(a: FailureMark, b: FailureMark): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry) => {
    const other = b.find((candidate) => candidate.source === entry.source);
    if (other === undefined) return false;
    const { matched, remaining } = pairFailureKeys({ carried: entry.keys, rerun: other.keys });
    return matched.size === entry.keys.length && remaining.size === 0;
  });
}
