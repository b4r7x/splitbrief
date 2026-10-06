import { describe, it, expect } from 'vitest';
import { TaskSpecSchema } from '../../../core/schemas/plan.js';
import { READ_ONLY_CONTEXT_HEADING } from '../headings.js';
import { buildLanguageContext } from './language-context.js';
import { buildTaskFormatExample } from './task-format-example.js';

describe('buildTaskFormatExample', () => {
  it.each(['typescript', 'javascript', 'python', 'go', 'rust'])(
    'names the file of a %s project',
    (language) => {
      const ctx = buildLanguageContext(language);

      expect(buildTaskFormatExample(ctx)).toContain(`src/path/to/file${ctx.fileExtension}`);
    },
  );

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

  it('states field vocabularies in prose instead of alternations in the specimen', () => {
    const example = buildTaskFormatExample();

    expect(example).not.toContain('action: create | modify');
    expect(example).not.toContain('depends_on: [] | [T001, T002]');
    expect(example).toContain('`action` — exactly `create` or `modify`.');
    expect(example).toContain('`[T001, T002]` when it must run after both');
  });

  it('shows a files list', () => {
    const ctx = buildLanguageContext('typescript');
    const example = buildTaskFormatExample(ctx);

    expect(example).toContain('- `files` — optional YAML list');
    expect(example).toContain('files: [src/path/to/file.ts, src/path/to/file.test.ts]');
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
