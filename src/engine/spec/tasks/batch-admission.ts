import type { Task } from '../../../core/schemas/task.js';
import { error } from '../../../utils/error.js';
import {
  looksLikeTaskBlock,
  normalizeTaskSeparators,
  opensUnterminatedFrontmatter,
  parseTaskBlock,
  splitTaskBlocks,
  stripFileFrontmatter,
} from './blocks.js';
import type { TaskManifestBatch } from './partition.js';
import { TASK_COMPILATION_FAILURE_CODE } from './task-compilation-codes.js';

export const batchAdmissionError = {
  empty: () =>
    error(
      TASK_COMPILATION_FAILURE_CODE.task_compiler_final_response_missing,
      'The batch artifact is empty; the required final response is missing.',
    ),
  refused: (detail: string) =>
    error(
      TASK_COMPILATION_FAILURE_CODE.task_compiler_provider_refused,
      `The batch reply contains no Task Briefs: ${detail}`,
      { detail },
    ),
  partial: () =>
    error(
      TASK_COMPILATION_FAILURE_CODE.task_compiler_output_limited,
      'The batch output is truncated: a Task Brief block is unterminated at end of input.',
    ),
  malformed: (detail: string) =>
    error(
      TASK_COMPILATION_FAILURE_CODE.task_compiler_invalid_markdown,
      `Invalid Task Brief block: ${detail}`,
      { detail },
    ),
  missingMember: (ids: readonly string[]) =>
    error(
      TASK_COMPILATION_FAILURE_CODE.task_compiler_manifest_mismatch,
      `Batch is missing expected items: ${ids.join(', ')}`,
      { ids },
    ),
  duplicateMember: (id: string) =>
    error(
      TASK_COMPILATION_FAILURE_CODE.task_compiler_duplicate_id,
      `Batch contains a duplicate Task ID: ${id}`,
      { id },
    ),
  unexpectedMember: (id: string) =>
    error(
      TASK_COMPILATION_FAILURE_CODE.task_compiler_manifest_mismatch,
      `Batch contains an unexpected Task ID: ${id}`,
      { id },
    ),
  memberMismatch: (id: string, detail: string) =>
    error(
      TASK_COMPILATION_FAILURE_CODE.task_compiler_manifest_mismatch,
      `Task ${id} does not cover its manifest item: ${detail}`,
      { id, detail },
    ),
} as const;

export type AdmitTaskBatchOptions = Readonly<
  | {
      batch: Pick<TaskManifestBatch, 'items'>;
      expectedIds?: undefined;
    }
  | {
      batch?: undefined;
      expectedIds: readonly string[];
    }
>;

type ExpectedBatchMember = TaskManifestBatch['items'][number] | Readonly<{ id: string }>;

function expectedBatchMembers(
  options: AdmitTaskBatchOptions,
): ReadonlyMap<string, ExpectedBatchMember> {
  const members =
    options.batch !== undefined ? options.batch.items : options.expectedIds.map((id) => ({ id }));
  return new Map(members.map((member) => [String(member.id), member]));
}

/**
 * Batch admission: block schema parse only, never global resolution. The artifact must be
 * non-empty, parse as Task Brief blocks, and cover every expected manifest item exactly once.
 * Refusal prose, truncation, partial output, malformed blocks, and missing, duplicate, or
 * unexpected items fail with stable compiler failure codes before any global merge.
 */
export function admitTaskBatch(text: string, options: AdmitTaskBatchOptions): Task[] {
  if (text.trim() === '') throw batchAdmissionError.empty();

  const stripped = normalizeTaskSeparators(stripFileFrontmatter(text));
  const blocks = splitTaskBlocks(stripped);
  const tasks: Task[] = [];
  let unterminated = false;

  for (const block of blocks) {
    const parsed = parseTaskBlock(block);
    if (parsed.ok) {
      tasks.push(parsed.task);
      continue;
    }
    if (opensUnterminatedFrontmatter(block)) {
      unterminated = true;
      continue;
    }
    if (looksLikeTaskBlock(block)) throw batchAdmissionError.malformed(parsed.reason);
  }
  if (unterminated) throw batchAdmissionError.partial();
  if (tasks.length === 0) {
    throw batchAdmissionError.refused('no --- delimited block with an id: field was found');
  }

  const expectedById = expectedBatchMembers(options);
  const seen = new Set<string>();
  for (const task of tasks) {
    const id = String(task.id);
    if (seen.has(id)) throw batchAdmissionError.duplicateMember(id);
    seen.add(id);
    const expected = expectedById.get(id);
    if (expected === undefined) throw batchAdmissionError.unexpectedMember(id);
    if ('file' in expected && (task.file !== expected.file || task.action !== expected.action)) {
      throw batchAdmissionError.memberMismatch(
        id,
        `expected ${expected.action} ${expected.file}, received ${task.action} ${task.file}`,
      );
    }
  }
  const missing = [...expectedById.keys()].filter((id) => !seen.has(id));
  if (missing.length > 0) throw batchAdmissionError.missingMember(missing);

  return tasks;
}
