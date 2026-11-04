import type { AttemptBrief } from '../../../src/engine/orchestrator/isolation/types.js';
import { makeTask } from './task.js';

/** A brief whose start records no write of its own, so a put-back of the brief acts on no file. */
export function makeAttemptBrief(): AttemptBrief {
  return {
    task: makeTask(),
    taskStartSnapshot: { head: '', files: [], dirtyFileContents: {} },
  };
}
