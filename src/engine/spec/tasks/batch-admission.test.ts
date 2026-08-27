import { describe, it, expect } from 'vitest';
import { admitTaskBatch } from './batch-admission.js';
import { parseTaskManifest } from './manifest.js';
import { partitionManifest, type TaskManifestBatch } from './partition.js';

function planWithFiles(count: number): string {
  const newFiles = Array.from(
    { length: count },
    (_, index) =>
      `- \`src/generated/file-${index + 1}.ts\`\n  Purpose: implement file ${index + 1}.`,
  ).join('\n');
  return `# Plan\n\n## File Structure\n### New Files\n${newFiles}\n\n### Modified Files\n\n## Dependencies\nNone.`;
}

function batchFixture(count = 4, batchOrdinal = 0): TaskManifestBatch {
  const plan = planWithFiles(count);
  const manifest = parseTaskManifest(plan);
  const partition = partitionManifest(manifest, {
    spec: 'spec',
    plan,
    languageContext: 'TypeScript/ESM',
  });
  const batch = partition.batches[batchOrdinal];
  if (batch === undefined) throw new Error(`expected batch ${batchOrdinal}`);
  return batch;
}

function briefBlock(id: string, file: string, action: 'create' | 'modify' = 'create'): string {
  return `---
id: ${id}
title: "Task ${id}"
action: ${action}
file: ${file}
depends_on: []
---

### Description
Implement ${file}.

### Tests
- ${id} works

### Constraints
- none
`;
}

describe('admitTaskBatch', () => {
  it('admits exactly the expected items once each with stable file and action', () => {
    const batch = batchFixture();
    const text = batch.items.map((item) => briefBlock(String(item.id), item.file)).join('\n');

    const tasks = admitTaskBatch(text, { batch });

    expect(tasks.map((task) => String(task.id))).toEqual(['T001', 'T002', 'T003', 'T004']);
    expect(tasks.map((task) => task.file)).toEqual(batch.items.map((item) => item.file));
    expect(tasks.every((task) => task.status === 'pending')).toBe(true);
  });

  it('refuses refusal prose with the stable refusal code', () => {
    const batch = batchFixture();
    expect(() =>
      admitTaskBatch('I cannot compile these briefs without more context.', { batch }),
    ).toThrow(expect.objectContaining({ kind: 'task_compiler_provider_refused' }));
  });

  it('refuses a code-fenced reply that carries no bare brief blocks', () => {
    const batch = batchFixture();
    const fenced = `\`\`\`markdown\n${batch.items
      .map((item) => briefBlock(String(item.id), item.file))
      .join('\n')}\n\`\`\``;
    expect(() => admitTaskBatch(fenced, { batch })).toThrow(
      expect.objectContaining({ kind: 'task_compiler_provider_refused' }),
    );
  });

  it.each([[''], ['   \n  ']])('fails an empty artifact with the final-response code', (text) => {
    const batch = batchFixture();
    expect(() => admitTaskBatch(text, { batch })).toThrow(
      expect.objectContaining({ kind: 'task_compiler_final_response_missing' }),
    );
  });

  it('fails a truncated artifact with an unterminated trailing block as partial output', () => {
    const batch = batchFixture();
    const valid = batch.items
      .slice(0, 3)
      .map((item) => briefBlock(String(item.id), item.file))
      .join('\n');
    const unterminated = `---
id: T099
title: "Cut off"
action: create
file: src/cut-off.ts
depends_on: []
`;
    expect(() => admitTaskBatch(`${valid}\n${unterminated}`, { batch })).toThrow(
      expect.objectContaining({ kind: 'task_compiler_output_limited' }),
    );
  });

  it('fails a task-shaped block with malformed frontmatter as invalid markdown', () => {
    const batch = batchFixture();
    const malformed = `---
id: T001
title:
action: create
file: src/generated/file-1.ts
depends_on: []
---

### Description
Empty title fails the block schema.
`;
    expect(() => admitTaskBatch(malformed, { batch })).toThrow(
      expect.objectContaining({ kind: 'task_compiler_invalid_markdown' }),
    );
  });

  it('fails an incomplete batch as missing manifest members', () => {
    const batch = batchFixture();
    const text = batch.items
      .slice(0, 3)
      .map((item) => briefBlock(String(item.id), item.file))
      .join('\n');
    expect(() => admitTaskBatch(text, { batch })).toThrow(
      expect.objectContaining({ kind: 'task_compiler_manifest_mismatch' }),
    );
  });

  it('fails a duplicate member with the duplicate Task ID code', () => {
    const batch = batchFixture();
    const text = [
      briefBlock('T001', 'src/generated/file-1.ts'),
      briefBlock('T001', 'src/generated/file-1.ts'),
      briefBlock('T002', 'src/generated/file-2.ts'),
      briefBlock('T003', 'src/generated/file-3.ts'),
    ].join('\n');
    expect(() => admitTaskBatch(text, { batch })).toThrow(
      expect.objectContaining({ kind: 'task_compiler_duplicate_id' }),
    );
  });

  it('fails an unexpected member with the manifest-mismatch code', () => {
    const batch = batchFixture();
    const text = [
      briefBlock('T001', 'src/generated/file-1.ts'),
      briefBlock('T002', 'src/generated/file-2.ts'),
      briefBlock('T003', 'src/generated/file-3.ts'),
      briefBlock('T999', 'src/generated/extra.ts'),
    ].join('\n');
    expect(() => admitTaskBatch(text, { batch })).toThrow(
      expect.objectContaining({ kind: 'task_compiler_manifest_mismatch' }),
    );
  });

  it('fails a member that targets a different file or action than its manifest item', () => {
    const batch = batchFixture();
    const text = [
      briefBlock('T001', 'src/generated/wrong-file.ts'),
      briefBlock('T002', 'src/generated/file-2.ts'),
      briefBlock('T003', 'src/generated/file-3.ts'),
      briefBlock('T004', 'src/generated/file-4.ts'),
    ].join('\n');
    expect(() => admitTaskBatch(text, { batch })).toThrow(
      expect.objectContaining({ kind: 'task_compiler_manifest_mismatch' }),
    );
  });

  it('enforces id membership alone when only expected ids are supplied', () => {
    const batch = batchFixture();
    const expectedIds = batch.items.map((item) => String(item.id));
    const text = batch.items.map((item) => briefBlock(String(item.id), item.file)).join('\n');

    const tasks = admitTaskBatch(text, { expectedIds });

    expect(tasks.map((task) => String(task.id))).toEqual(['T001', 'T002', 'T003', 'T004']);
  });

  it('fails an incomplete batch as missing members when only expected ids are supplied', () => {
    const batch = batchFixture();
    const expectedIds = batch.items.map((item) => String(item.id));
    const text = batch.items
      .slice(0, 3)
      .map((item) => briefBlock(String(item.id), item.file))
      .join('\n');
    expect(() => admitTaskBatch(text, { expectedIds })).toThrow(
      expect.objectContaining({ kind: 'task_compiler_manifest_mismatch' }),
    );
  });

  it('fails an unexpected task id with the manifest-mismatch code when only expected ids are supplied', () => {
    const batch = batchFixture();
    const expectedIds = batch.items.map((item) => String(item.id));
    const text = [
      briefBlock('T001', 'src/generated/file-1.ts'),
      briefBlock('T002', 'src/generated/file-2.ts'),
      briefBlock('T003', 'src/generated/file-3.ts'),
      briefBlock('T099', 'src/generated/extra.ts'),
    ].join('\n');
    expect(() => admitTaskBatch(text, { expectedIds })).toThrow(
      expect.objectContaining({ kind: 'task_compiler_manifest_mismatch' }),
    );
  });
});
