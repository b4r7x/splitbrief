import {
  createTaskCompilationBatchId,
  createTaskCompilationProgramId,
  TASK_BRIEF_COMPILER_POLICY,
  type TaskCompilationBatchId,
  type TaskCompilationPolicy,
  type TaskCompilationProgramId,
} from '../../../core/schemas/task-compilation.js';
import { error } from '../../../utils/error.js';
import {
  digestManifest,
  TaskManifestSchema,
  taskManifestError,
  type TaskManifest,
  type TaskManifestItem,
} from './manifest.js';

export type TaskCompilationProgramInputs = Readonly<{
  spec?: string;
  plan?: string;
  languageContext?: string;
  repairSubject?: string | null;
}>;

export type TaskManifestBatch = Readonly<{
  ordinal: number;
  batchId: TaskCompilationBatchId;
  manifestOrdinals: readonly number[];
  items: readonly TaskManifestItem[];
}>;

export type TaskManifestPartition = Readonly<{
  policyVersion: TaskCompilationPolicy['version'];
  programId: TaskCompilationProgramId;
  manifestDigest: string;
  batches: readonly TaskManifestBatch[];
}>;

export const partitionError = {
  capacity: (count: number, batches: number, limit: number) =>
    error(
      'task_compiler_capacity_exceeded',
      `The manifest requires ${batches} dispatches for ${count} items; the V1 limit is ${limit}.`,
      { count, batches, limit },
    ),
  invalidManifest: (detail: string) =>
    error('task_compiler_manifest_invalid', `Cannot partition the manifest: ${detail}`, { detail }),
} as const;

export function partitionManifest(
  manifest: TaskManifest,
  inputs: TaskCompilationProgramInputs = {},
  policy: TaskCompilationPolicy = TASK_BRIEF_COMPILER_POLICY,
): TaskManifestPartition {
  const count = manifest.items.length;
  const batchCount = Math.ceil(count / policy.maxBatchItems);
  if (batchCount > policy.maxDispatches) {
    throw partitionError.capacity(count, batchCount, policy.maxDispatches);
  }

  const programId = createProgramId(manifest, inputs, policy);
  const batches: TaskManifestBatch[] = [];
  for (let ordinal = 0; ordinal < batchCount; ordinal++) {
    const manifestOrdinals = Object.freeze(
      Array.from(
        { length: Math.min(policy.maxBatchItems, count - ordinal * policy.maxBatchItems) },
        (_, offset) => ordinal * policy.maxBatchItems + offset,
      ),
    );
    const items = Object.freeze(
      manifestOrdinals.map((manifestOrdinal) => {
        const item = manifest.items[manifestOrdinal];
        if (item === undefined)
          throw partitionError.invalidManifest(`missing ordinal ${manifestOrdinal}`);
        return item;
      }),
    );
    batches.push({
      ordinal,
      batchId: createTaskCompilationBatchId(programId, ordinal, manifestOrdinals),
      manifestOrdinals,
      items,
    });
  }

  return Object.freeze({
    policyVersion: policy.version,
    programId,
    manifestDigest: manifest.manifestDigest,
    batches: Object.freeze(batches.map((batch) => Object.freeze(batch))),
  });
}

export function createProgramId(
  manifest: TaskManifest,
  inputs: TaskCompilationProgramInputs = {},
  policy: TaskCompilationPolicy = TASK_BRIEF_COMPILER_POLICY,
): TaskCompilationProgramId {
  assertManifest(manifest, policy);
  return createTaskCompilationProgramId({
    policyVersion: policy.version,
    spec: inputs.spec ?? '',
    plan: inputs.plan ?? '',
    languageContext: inputs.languageContext ?? '',
    repairSubject: inputs.repairSubject ?? null,
    manifestDigest: manifest.manifestDigest,
    manifest: manifest.items,
  });
}

function assertManifest(manifest: TaskManifest, policy: TaskCompilationPolicy): void {
  const parsed = TaskManifestSchema.safeParse(manifest);
  if (!parsed.success) throw partitionError.invalidManifest(parsed.error.message);
  if (manifest.items.length === 0) throw taskManifestError.empty();
  if (manifest.items.length > policy.maxManifestItems) {
    throw taskManifestError.capacity(manifest.items.length, policy.maxManifestItems);
  }
  for (let ordinal = 0; ordinal < manifest.items.length; ordinal++) {
    const item = manifest.items[ordinal];
    if (item === undefined || item.ordinal !== ordinal) {
      throw partitionError.invalidManifest(`manifest ordinal ${ordinal} is not stable`);
    }
  }
  const expectedDigest = digestManifest(policy.version, manifest.items);
  if (manifest.manifestDigest !== expectedDigest) {
    throw partitionError.invalidManifest('manifest digest does not match its items');
  }
}
