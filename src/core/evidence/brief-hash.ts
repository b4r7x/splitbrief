import type { Task } from '../schemas/task.js';
import { canonicalJSON } from '../../utils/canonical-json.js';
import { sha256Hex } from '../../utils/sha256.js';

export function hashTaskBrief(tasks: Task[]): string {
  const stripped = tasks.map(
    ({
      currentCode: _c,
      currentCodeByFile: _otherCode,
      contextCodeByFile: _contextCode,
      status: _s,
      checkResults: _checkResults,
      ...rest
    }) =>
      // Briefs saved before every check had to pass hashed a `required` flag on each check. Every
      // check is now required, so hashing it as `true` keeps the hash of such a brief.
      rest.checks === undefined
        ? rest
        : { ...rest, checks: rest.checks.map((check) => ({ ...check, required: true })) },
  );
  const json = canonicalJSON(stripped);
  return sha256Hex(json);
}
