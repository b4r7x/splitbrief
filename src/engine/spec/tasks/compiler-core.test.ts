import { describe, expect, it } from 'vitest';
import { createTaskManifest, parseTaskManifest } from './manifest.js';
import { partitionManifest } from './partition.js';

function planWithFiles(count: number): string {
  const newFiles = Array.from(
    { length: count },
    (_, index) =>
      `- \`src/generated/file-${index + 1}.ts\`\n  Purpose: implement file ${index + 1}.`,
  ).join('\n');
  return `# Plan\n\n## File Structure\n### New Files\n${newFiles}\n\n### Modified Files\n\n## Dependencies\nNone.`;
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
    expect(() => createTaskManifest(manifestEntries)).toThrow(
      expect.objectContaining({ kind: 'task_compiler_capacity_exceeded' }),
    );
  });

  it('rejects empty, ambiguous, unsafe, and duplicate File Structure entries', () => {
    expect(() => parseTaskManifest(planWithFiles(0))).toThrow(
      expect.objectContaining({ kind: 'task_compiler_manifest_empty' }),
    );
    expect(() =>
      parseTaskManifest(
        '# Plan\n\n## File Structure\n### New Files\n- `src/new.ts` — maybe\n### Modified Files',
      ),
    ).toThrow(expect.objectContaining({ kind: 'task_compiler_manifest_invalid' }));
    expect(() =>
      parseTaskManifest(
        '# Plan\n\n## File Structure\n### New Files\n- `../escape.ts`\n  Purpose: escape\n### Modified Files',
      ),
    ).toThrow(expect.objectContaining({ kind: 'task_compiler_manifest_invalid' }));
    expect(() =>
      parseTaskManifest(
        '# Plan\n\n## File Structure\n### New Files\n- `src/same.ts`\n  Purpose: first\n### Modified Files\n- `src/same.ts`\n  Purpose: second',
      ),
    ).toThrow(expect.objectContaining({ kind: 'task_compiler_manifest_invalid' }));
  });

  it('rejects an indented bullet in purpose position', () => {
    expect(() =>
      parseTaskManifest(
        '# Plan\n\n## File Structure\n### New Files\n- `src/a.ts`\n  - src/b.ts\n### Modified Files',
      ),
    ).toThrow(expect.objectContaining({ kind: 'task_compiler_manifest_invalid' }));
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
