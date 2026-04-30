import { createHash } from 'node:crypto';
import type { Task } from './schemas/task.js';
import { canonicalJSON } from '../utils/canonical-json.js';

export function hashTaskBrief(tasks: Task[]): string {
  const stripped = tasks.map(({ currentCode: _c, status: _s, ...rest }) => rest);
  const json = canonicalJSON(stripped);
  return createHash('sha256').update(json).digest('hex');
}
