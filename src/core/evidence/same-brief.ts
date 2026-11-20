import type { EvidenceTask } from '../schemas/evidence.js';
import type { Task } from '../schemas/task.js';
import { hashTaskBrief } from './brief-hash.js';

/**
 * Whether a ledger entry records work on this brief as the plan states it now. The ledger books a
 * retried attempt `failed`, so an in-progress brief joins a failed entry too, and a brief stopped
 * before the ledger booked anything still has its pending seed. An unstamped entry (a seed, or one
 * written before the ledger stamped its briefs) joins by title and anchor file.
 */
export function sameCurrentBrief(entry: EvidenceTask, task: Task): boolean {
  if (task.status === 'pending' && entry.status !== 'pending') return false;
  if (
    task.status === 'in_progress' &&
    entry.status !== 'in_progress' &&
    entry.status !== 'failed' &&
    entry.status !== 'pending'
  )
    return false;
  if (entry.briefHash != null) return entry.briefHash === hashTaskBrief([task]);
  return entry.title === task.title && entry.file === task.suggestedFiles[0];
}
