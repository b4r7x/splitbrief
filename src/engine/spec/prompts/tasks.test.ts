import { describe, it, expect } from 'vitest';
import { TASK_BRIEF_COMPILER_POLICY } from '../../../core/schemas/task-compilation.js';
import type { TaskCompilationCallEnvelope } from '../../../core/schemas/task-compilation.js';
import { parseTaskManifest } from '../tasks/manifest.js';
import { partitionManifest } from '../tasks/partition.js';
import { buildLanguageContext } from './language-context.js';
import { buildTasksPrompt, buildTaskBatchPrompt, taskBatchPromptByteLength } from './tasks.js';

describe('buildTasksPrompt', () => {
  it('TypeScript project prompt keeps TypeScript conventions', () => {
    const prompt = buildTasksPrompt({
      spec: 'spec',
      plan: 'plan',
      languageContext: buildLanguageContext('typescript'),
    });
    expect(prompt).toContain('typescript');
    expect(prompt).toContain('.js');
    expect(prompt).toContain('file: src/path/to/file.ts');
    expect(prompt).toContain('```typescript');
  });

  it('Python project prompt has no TypeScript references', () => {
    const prompt = buildTasksPrompt({
      spec: 'spec',
      plan: 'plan',
      languageContext: buildLanguageContext('python'),
    });
    expect(prompt).toContain('Python');
    expect(prompt).toContain('PEP 484');
    expect(prompt).toContain('file: src/path/to/file.py');
    expect(prompt).toContain('```python');
    expect(prompt).not.toMatch(/TypeScript|typescript|\.js extensions|file\.ts/);
  });

  it('generic prompt has no language-specific references', () => {
    const prompt = buildTasksPrompt({ spec: 'spec', plan: 'plan' });
    expect(prompt).not.toMatch(/TypeScript|typescript|\.js extensions|file\.ts|PEP 484/);
  });

  it('returns task content for session persistence without requesting project writes', () => {
    const prompt = buildTasksPrompt({ spec: 'spec', plan: 'plan' });
    expect(prompt).toContain('SPLITBRIEF captures your reply');
    expect(prompt).toContain('persists the tasks.md artifact inside the active session');
    expect(prompt).toContain('Do not write tasks.md or any other project file yourself');
    expect(prompt).not.toContain('write it to tasks.md at the project root');
  });

  it('reserves bare separators for Task Brief frontmatter', () => {
    const prompt = buildTasksPrompt({ spec: 'spec', plan: 'plan' });
    expect(prompt).toContain(
      'Outside fenced code blocks, lines containing only `---` are reserved',
    );
    expect(prompt).toContain(
      'Never use a bare `---` as a horizontal rule or phase-heading separator',
    );
  });
});

function planWithFiles(count: number): string {
  const newFiles = Array.from(
    { length: count },
    (_, index) =>
      `- \`src/generated/file-${index + 1}.ts\`\n  Purpose: implement file ${index + 1}.`,
  ).join('\n');
  return `# Plan\n\n## File Structure\n### New Files\n${newFiles}\n\n### Modified Files\n\n## Dependencies\nNone.`;
}

function batchFixture(count: number): ReturnType<typeof partitionManifest> {
  const plan = planWithFiles(count);
  const manifest = parseTaskManifest(plan);
  return partitionManifest(manifest, { spec: 'spec', plan, languageContext: 'TypeScript/ESM' });
}

function envelope(promptBytes: number): TaskCompilationCallEnvelope {
  return {
    version: 1,
    promptBytes,
    inputTokensUpperBound: 1_000,
    requestedOutputTokens: TASK_BRIEF_COMPILER_POLICY.requestedOutputTokens,
    outputTokensUpperBound: 2_000,
    maxNormalizedOutputBytes: TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes,
    maxDeclaredArtifactBytes: TASK_BRIEF_COMPILER_POLICY.maxDeclaredArtifactBytes,
    maxRawProtocolBytes: TASK_BRIEF_COMPILER_POLICY.maxRawProtocolBytes,
    maxStderrBytes: TASK_BRIEF_COMPILER_POLICY.maxStderrBytes,
    deadlineMs: TASK_BRIEF_COMPILER_POLICY.deadlineMs,
    idleTimeoutMs: TASK_BRIEF_COMPILER_POLICY.idleTimeoutMs,
  };
}

describe('buildTaskBatchPrompt', () => {
  it('carries the exact program and batch identity of the selected slice', () => {
    const partition = batchFixture(12);
    const batch = partition.batches[1];
    if (batch === undefined) throw new Error('expected batch 1');
    const prompt = buildTaskBatchPrompt({
      programId: partition.programId,
      batch,
      backwardDependencies: partition.batches[0]?.items ?? [],
    });

    expect(prompt).toContain(`Program: \`${partition.programId}\``);
    expect(prompt).toContain(`Batch: \`${batch.batchId}\``);
    expect(prompt).toContain('Compile exactly these 4 manifest items — nothing more, nothing less');
  });

  it('lists exactly the selected items with their manifest targets and no later items', () => {
    const partition = batchFixture(12);
    const batch = partition.batches[0];
    if (batch === undefined) throw new Error('expected batch 0');
    const prompt = buildTaskBatchPrompt({
      programId: partition.programId,
      batch,
      backwardDependencies: [],
    });

    for (const item of batch.items) {
      expect(prompt).toContain(`- \`${item.id}\` — ${item.action} \`${item.file}\``);
      expect(prompt).toContain(`Purpose: ${item.purpose}`);
    }
    for (const id of ['T005', 'T006', 'T007', 'T008', 'T012']) {
      expect(prompt).not.toContain(`\`${id}\``);
    }
  });

  it('declares only backward-only dependencies as allowed depends_on targets', () => {
    const partition = batchFixture(12);
    const batch = partition.batches[1];
    const first = partition.batches[0];
    if (batch === undefined || first === undefined) throw new Error('expected batches 0 and 1');
    const prompt = buildTaskBatchPrompt({
      programId: partition.programId,
      batch,
      backwardDependencies: first.items,
    });

    for (const item of first.items) {
      expect(prompt).toContain(`- \`${item.id}\` — ${item.action} \`${item.file}\``);
    }
    expect(prompt).toContain('Every `depends_on` value must name an item listed in this prompt');
    expect(prompt).toContain('Never name an unlisted or later item');
    expect(prompt).toContain('use `[]` when independent');
    for (const id of ['T009', 'T010', 'T011', 'T012']) {
      expect(prompt).not.toContain(`\`${id}\``);
    }
  });

  it('forbids dependencies when no earlier manifest items exist', () => {
    const partition = batchFixture(4);
    const batch = partition.batches[0];
    if (batch === undefined) throw new Error('expected batch 0');
    const prompt = buildTaskBatchPrompt({
      programId: partition.programId,
      batch,
      backwardDependencies: [],
    });

    expect(prompt).toContain('No earlier manifest items exist');
    expect(prompt).toContain('Every `depends_on` must be `[]`');
  });

  it('demands exactly the selected complete blocks in the final response and forbids writes', () => {
    const partition = batchFixture(4);
    const batch = partition.batches[0];
    if (batch === undefined) throw new Error('expected batch 0');
    const prompt = buildTaskBatchPrompt({
      programId: partition.programId,
      batch,
      backwardDependencies: [],
    });

    expect(prompt).toContain('Emit exactly the 4 selected complete Product Task Brief v1 blocks');
    expect(prompt).toContain('one `---` delimited block per manifest item');
    expect(prompt).toContain('not wrapped in a code fence');
    expect(prompt).toContain('no phase headings, summary, or trailing prose');
    expect(prompt).toContain(
      'Return exactly the selected Task Brief blocks in your final response',
    );
    expect(prompt).toContain('Do not write, create, or modify any file');
    expect(prompt).toContain('do not read, resume, or reference any session state');
    expect(prompt).toContain('SPLITBRIEF captures only your final response as the batch artifact');
  });

  it('keeps language-specific conventions from the language context', () => {
    const partition = batchFixture(4);
    const batch = partition.batches[0];
    if (batch === undefined) throw new Error('expected batch 0');
    const base = { programId: partition.programId, batch, backwardDependencies: [] as const };

    const typescript = buildTaskBatchPrompt(base, {
      languageContext: buildLanguageContext('typescript'),
    });
    expect(typescript).toContain('file: src/path/to/file.ts');
    expect(typescript).toContain('```typescript');

    const python = buildTaskBatchPrompt(base, {
      languageContext: buildLanguageContext('python'),
    });
    expect(python).toContain('file: src/path/to/file.py');
    expect(python).not.toMatch(/TypeScript|typescript|file\.ts/);
  });

  it('admits the prompt within the envelope bound before dispatch', () => {
    const partition = batchFixture(4);
    const batch = partition.batches[0];
    if (batch === undefined) throw new Error('expected batch 0');
    const base = { programId: partition.programId, batch, backwardDependencies: [] as const };

    const admitted = buildTaskBatchPrompt(base);
    expect(taskBatchPromptByteLength(admitted)).toBeLessThanOrEqual(
      TASK_BRIEF_COMPILER_POLICY.maxPromptBytes,
    );

    const admittedWithEnvelope = buildTaskBatchPrompt(base, { envelope: envelope(200_000) });
    expect(Buffer.byteLength(admittedWithEnvelope, 'utf8')).toBeLessThanOrEqual(200_000);
  });

  it('rejects a prompt that exceeds the envelope bound with the stable failure code', () => {
    const partition = batchFixture(4);
    const batch = partition.batches[0];
    if (batch === undefined) throw new Error('expected batch 0');
    const base = { programId: partition.programId, batch, backwardDependencies: [] as const };

    let thrown: unknown = null;
    try {
      buildTaskBatchPrompt(base, { envelope: envelope(100) });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ kind: 'task_compiler_prompt_too_large' });
  });
});
