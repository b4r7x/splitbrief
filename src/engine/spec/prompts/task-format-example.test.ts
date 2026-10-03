import { describe, it, expect } from 'vitest';
import { TaskSpecSchema } from '../../../core/schemas/plan.js';
import { formatTasks } from '../formatter.js';
import { READ_ONLY_CONTEXT_HEADING } from '../headings.js';
import { parseTasks, parseTasksStrict } from '../tasks/parse.js';
import { buildLanguageContext } from './language-context.js';
import { buildTaskFormatExample } from './task-format-example.js';

// A tasks.md brief carries no read-only context section: the CLI adds it to the prompt from
// `contextFiles`. A skill brief carries it, so the grammar is checked on what is left.
function withoutReadOnlyContext(example: string): string {
  const start = example.indexOf(`\n${READ_ONLY_CONTEXT_HEADING} — `);
  const fenceEnd = example.indexOf('\n```\n', example.indexOf('\n```', start + 1) + 1);
  return example.slice(0, start) + example.slice(fenceEnd + '\n```\n'.length);
}

describe('buildTaskFormatExample round-trip', () => {
  it('parses back into one task with the id the example shows', () => {
    const tasks = parseTasks(buildTaskFormatExample());

    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe('T001');
    expect(tasks[0]?.action).toBe('create');
    expect(tasks[0]?.dependsOn).toEqual([]);
  });

  it.each(['typescript', 'javascript', 'python', 'go', 'rust'])(
    'parses back into one task for a %s project',
    (language) => {
      const ctx = buildLanguageContext(language);
      const tasks = parseTasks(buildTaskFormatExample(ctx));

      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.id).toBe('T001');
      expect(tasks[0]?.file).toBe(`src/path/to/file${ctx.fileExtension}`);
    },
  );

  it('survives parseTasksStrict without a single warning', () => {
    const warnings: string[] = [];
    const tasks = parseTasksStrict(
      withoutReadOnlyContext(buildTaskFormatExample(buildLanguageContext('typescript'))),
      (message) => warnings.push(message),
    );

    expect(tasks).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it('shows code fences the section extractor can actually read', () => {
    const tasks = parseTasks(buildTaskFormatExample(buildLanguageContext('typescript')));

    expect(tasks[0]?.signature).toBe('export function exampleFn(param: Type): ReturnType');
    expect(tasks[0]?.typeDefs).toBe('// All referenced types, copied verbatim');
    expect(tasks[0]?.currentCode).toBeUndefined();
  });

  it('shows the code of a context file in its read-only context section', () => {
    const example = buildTaskFormatExample(buildLanguageContext('typescript'));

    expect(example).toContain(
      `${READ_ONLY_CONTEXT_HEADING} — src/path/to/context.ts\n\`\`\`typescript\n// The current code of a context file the change reads but does not write\n\`\`\``,
    );
    expect(example).toContain(
      `- \`contextFiles\` → one \`${READ_ONLY_CONTEXT_HEADING} — <path>\` section per file, with its current code.`,
    );
    expect(example).not.toContain('### Current Code');
  });

  it('fills every Task Brief section the example advertises', () => {
    const task = parseTasks(buildTaskFormatExample())[0];

    expect(task?.description).toContain('What to implement and why');
    expect(task?.pattern).toContain('Existing codebase pattern');
    expect(task?.implementationSteps).toHaveLength(3);
    expect(task?.tests).toEqual(['Test case with concrete inputs/outputs']);
    expect(task?.scope?.inBounds).toBeUndefined();
    expect(task?.scope?.outOfBounds).toEqual(['Explicit exclusion the reviewer checks']);
    expect(task?.evidence).toEqual([
      'Reviewable proof the task completed (the focused tests that pass, the changed files, the behavior a reviewer can check).',
    ]);
    expect(task?.scope?.approvedOutOfBounds).toHaveLength(1);
    expect(task?.escalation).toHaveLength(1);
    expect(task?.evidence).toHaveLength(1);
    expect(task?.constraints).toHaveLength(2);
  });

  it('survives the formatter the product writes tasks.md with', () => {
    const parsed = parseTasksStrict(
      withoutReadOnlyContext(buildTaskFormatExample(buildLanguageContext('typescript'))),
    );

    expect(parseTasksStrict(formatTasks(parsed))).toEqual(parsed);
  });

  it('states field vocabularies in prose instead of alternations in the specimen', () => {
    const example = buildTaskFormatExample();

    expect(example).not.toContain('action: create | modify');
    expect(example).not.toContain('depends_on: [] | [T001, T002]');
    expect(example).toContain('`action` — exactly `create` or `modify`.');
    expect(example).toContain('`[T001, T002]` when it must run after both');
  });

  it('shows a files list the parser round-trips as the slice it declares', () => {
    const ctx = buildLanguageContext('typescript');
    const example = buildTaskFormatExample(ctx);

    expect(example).toContain('- `files` — optional YAML list');
    expect(example).toContain('files: [src/path/to/file.ts, src/path/to/file.test.ts]');
    expect(parseTasks(example)[0]?.files).toEqual([
      'src/path/to/file.ts',
      'src/path/to/file.test.ts',
    ]);
  });

  it('maps every plan task field to its place in the brief', () => {
    const example = buildTaskFormatExample();

    for (const field of Object.keys(TaskSpecSchema.shape)) {
      expect(example).toMatch(new RegExp(`^- \`${field}\` → `, 'm'));
    }
    expect(example).toContain(
      '- `suggestedFiles` → frontmatter `file` (the first one) and `files`',
    );
    expect(example).toContain('- `exclusions` → `### Scope` under `**Out of bounds:**`.');
  });

  it('is not wrapped in a code fence of its own', () => {
    expect(buildTaskFormatExample().trimStart().startsWith('```')).toBe(false);
  });
});
