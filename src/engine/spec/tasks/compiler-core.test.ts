import { describe, expect, it } from 'vitest';
import { TASK_BRIEF_COMPILER_POLICY } from '../../../core/schemas/task-compilation.js';
import { createTaskManifest, parseTaskManifest } from './manifest.js';
import { partitionError, partitionManifest } from './partition.js';

function planWithFiles(count: number): string {
  const newFiles = Array.from(
    { length: count },
    (_, index) =>
      `- \`src/generated/file-${index + 1}.ts\`\n  Purpose: implement file ${index + 1}.`,
  ).join('\n');
  return `# Plan\n\n## File Structure\n### New Files\n${newFiles}\n\n### Modified Files\n\n## Dependencies\nNone.`;
}

function expectErrorKind(run: () => unknown, kind: string): void {
  try {
    run();
    throw new Error('expected the operation to throw');
  } catch (err) {
    expect(err).toMatchObject({ kind });
  }
}

describe('task manifest and partition', () => {
  it.each([
    [1, 1],
    [4, 1],
    [5, 2],
    [256, 64],
  ])('partitions %i manifest items into %i batches', (count, expectedBatches) => {
    const manifest = parseTaskManifest(planWithFiles(count));
    const partition = partitionManifest(manifest, {
      spec: 'spec',
      plan: planWithFiles(count),
      languageContext: 'TypeScript/ESM',
    });

    expect(partition.batches).toHaveLength(expectedBatches);
    expect(partition.batches.flatMap((batch) => batch.manifestOrdinals)).toEqual(
      Array.from({ length: count }, (_, index) => index),
    );
    expect(new Set(partition.batches.map((batch) => batch.batchId)).size).toBe(expectedBatches);
    expect(partition.programId).toBe(
      partitionManifest(manifest, {
        spec: 'spec',
        plan: planWithFiles(count),
        languageContext: 'TypeScript/ESM',
      }).programId,
    );
  });

  it('rejects capacity before a dispatch can be created', () => {
    const manifestEntries = Array.from({ length: 257 }, (_, index) => ({
      action: 'create' as const,
      file: `src/generated/file-${index + 1}.ts`,
      purpose: `implement file ${index + 1}`,
    }));
    expectErrorKind(() => createTaskManifest(manifestEntries), 'task_compiler_capacity_exceeded');
    expect(partitionError.isCapacity).toBeTypeOf('function');
    expect(TASK_BRIEF_COMPILER_POLICY.maxDispatches).toBe(64);
  });

  it('rejects empty, ambiguous, unsafe, and duplicate File Structure entries', () => {
    expectErrorKind(() => parseTaskManifest(planWithFiles(0)), 'task_compiler_manifest_empty');
    expectErrorKind(
      () =>
        parseTaskManifest(
          '# Plan\n\n## File Structure\n### New Files\n- `src/new.ts` — maybe\n### Modified Files',
        ),
      'task_compiler_manifest_invalid',
    );
    expectErrorKind(
      () =>
        parseTaskManifest(
          '# Plan\n\n## File Structure\n### New Files\n- `../escape.ts`\n  Purpose: escape\n### Modified Files',
        ),
      'task_compiler_manifest_invalid',
    );
    expectErrorKind(
      () =>
        parseTaskManifest(
          '# Plan\n\n## File Structure\n### New Files\n- `src/same.ts`\n  Purpose: first\n### Modified Files\n- `src/same.ts`\n  Purpose: second',
        ),
      'task_compiler_manifest_invalid',
    );
  });

  it('rejects an indented bullet in purpose position', () => {
    expectErrorKind(
      () =>
        parseTaskManifest(
          '# Plan\n\n## File Structure\n### New Files\n- `src/a.ts`\n  - src/b.ts\n### Modified Files',
        ),
      'task_compiler_manifest_invalid',
    );
  });

  it('uses stable encounter-order IDs and digest independent of object reuse', () => {
    const plan = planWithFiles(2);
    const first = parseTaskManifest(plan);
    const second = parseTaskManifest(plan);
    expect(first.items.map((item) => item.id)).toEqual(['T001', 'T002']);
    expect(first.manifestDigest).toBe(second.manifestDigest);
    expect(first.items).not.toBe(second.items);
  });
});
