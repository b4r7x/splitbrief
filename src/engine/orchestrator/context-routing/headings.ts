import type { Task } from '../../../core/schemas/task.js';
import type { CurrentCodeContextMode } from '../../../core/schemas/enums.js';

export const TRUNCATION_MARKER = '// ... truncated to fit context window ...';
export const FUNCTION_CONTEXT_HEADING = '### Current Code (relevant section)';
export const WHOLE_FILE_CONTEXT_HEADING = '### Current Code';

export function currentCodeContextMode(task: Task, prompt: string): CurrentCodeContextMode {
  if (task.action !== 'modify' || !task.currentCode) return 'none';
  if (prompt.includes(FUNCTION_CONTEXT_HEADING)) return 'function-level';
  if (prompt.includes(TRUNCATION_MARKER)) return 'truncated';
  if (!prompt.includes(WHOLE_FILE_CONTEXT_HEADING)) return 'none';
  return prompt.includes(task.currentCode) ? 'whole-file' : 'truncated';
}
