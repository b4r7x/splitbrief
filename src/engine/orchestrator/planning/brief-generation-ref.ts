import type { BriefGenerationRef } from '../../../core/schemas/brief-owner.js';
import type { Task } from '../../../core/schemas/task.js';
import { sha256Hex } from '../../../utils/sha256.js';

/**
 * The approval-path Brief generation ref is a derived `brief-${epochId}-${tasksDigest.slice(0, 16)}`
 * identity, never an installed immutable generation: the approval loop and the
 * quick/instant settlement issue the execution permit without calling
 * `installBriefGeneration`, so REQ-023's immutable install happens only on the
 * producer path (`publishBriefGeneration`), whose canonical id is
 * `generation-${sha256(domain\u0000manifest)}`. The two id conventions coexist
 * by design; a producer-published parked state (canonical id) resumed through
 * the approval loop derives a different id, hits the generation-mismatch guard,
 * and parks (fail-closed). The digests bind the parsed Task identity
 * (id/file/action/dependsOn) and the full-task JSON, which the persisted-permit
 * revalidation at the task boundary recomputes from the same parsed bytes.
 */
export function briefGenerationRefFor(opts: {
  epochId: string;
  tasks: readonly Task[];
  qualityDigest: string;
}): BriefGenerationRef {
  const taskManifest = opts.tasks.map((task) => ({
    id: task.id,
    file: task.file,
    action: task.action,
    dependsOn: task.dependsOn,
  }));
  const tasksDigest = sha256Hex(JSON.stringify(opts.tasks));
  return {
    generationId: `brief-${opts.epochId}-${tasksDigest.slice(0, 16)}`,
    manifestDigest: sha256Hex(JSON.stringify(taskManifest)),
    tasksDigest,
    qualityDigest: opts.qualityDigest,
    programId: null,
  };
}
