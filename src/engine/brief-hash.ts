import type { Task } from '../core/schemas/task.js';
import { canonicalJSON } from '../utils/canonical-json.js';
import { sha256Hex } from '../utils/sha256.js';

export function hashTaskBrief(tasks: Task[]): string {
  const stripped = tasks.map(({ currentCode: _c, status: _s, ...rest }) => rest);
  const json = canonicalJSON(stripped);
  return sha256Hex(json);
}
