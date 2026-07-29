import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PTY_VIEWPORT = Object.freeze({ cols: 100, rows: 30 });

export const PTY_ACTIVE_REVIEW_MARKER = 'PTY active review contract';
export const PTY_EDITOR_STARTED_MARKER = 'PTY editor started';
export const PTY_EDITOR_FINISHED_MARKER = 'PTY editor finished';
export const PTY_APPROVED_MARKER = 'PTY contract approved';

export const PTY_APPROVAL_PREFIX = 'appro';
export const PTY_APPROVAL_SUFFIX = 've';
export const PTY_EDIT_INPUT = '\x1b[101;5u';
export const PTY_SUBMIT_INPUT = '\x1b[13u';
export const PTY_EXIT_INPUT = '\x1b[113;5u';

export const PTY_EDITOR_SENTINEL_ENV = 'SPLITBRIEF_PTY_EDITOR_SENTINEL';
export const PTY_CHILD_PROJECT_ENV = 'SPLITBRIEF_PTY_CHILD_PROJECT';

export type PtyRequirement = 'optional' | 'required';

export type PtySetupFailureCategory = 'module-unavailable' | 'api-incompatible' | 'spawn-failed';

export function isDirectExecution(moduleUrl: string, entrypoint = process.argv[1]): boolean {
  if (!entrypoint || !existsSync(entrypoint)) return false;
  return pathToFileURL(resolve(entrypoint)).href === moduleUrl;
}
