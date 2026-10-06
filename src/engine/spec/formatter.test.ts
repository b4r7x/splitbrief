import YAML from 'yaml';
import { describe, it, expect } from 'vitest';
import { formatTasks } from './formatter.js';
import { makeTask as makeBaseTask } from '#testing/helpers/factories/task.js';

type TaskOverrides = Parameters<typeof makeBaseTask>[0];

function makeTask(overrides: TaskOverrides = {}): ReturnType<typeof makeBaseTask> {
  return makeBaseTask({
    title: 'Create utility module',
    suggestedFiles: ['src/utils/helpers.ts'],
    description: 'Implement helper functions for string manipulation.',
    ...overrides,
  });
}

/** The YAML header of every brief in a `tasks.md`, read as YAML. */
function headers(markdown: string): unknown[] {
  return [...markdown.matchAll(/^---\n([\s\S]*?)\n---$/gm)].map((match) =>
    YAML.parse(match[1] ?? ''),
  );
}

describe('formatTasks', () => {
  it('handles the empty boundary', () => {
    expect(formatTasks([])).toBe('');
  });

  it('writes ordered briefs with their metadata and optional brief fields', () => {
    const first = makeTask({
      id: 'T001',
      title: 'My Task',
      action: 'modify',
      suggestedFiles: ['src/foo.ts'],
      description: 'Implement the helper function for string trimming.',
      implementationSteps: ['first step', 'second step'],
      tests: ['assertion one', 'assertion two'],
      constraints: ['no side effects', 'pure function'],
      escalation: ['stop on ambiguity'],
      evidence: ['npm test passes'],
      scope: {
        inBounds: ['only foo.ts'],
        outOfBounds: ['do not touch bar.ts'],
        approvedOutOfBounds: ['src/shared.ts'],
      },
      pattern: 'Follow the existing parseConfig(raw) guard shape.',
    });
    const second = makeBaseTask({
      id: 'T002',
      title: 'Second',
      suggestedFiles: ['src/bar.ts'],
      description: 'Do bar',
      dependsOn: [first.id],
    });

    const markdown = formatTasks([first, second]);

    expect(headers(markdown)).toEqual([
      {
        id: 'T001',
        title: 'My Task',
        action: 'modify',
        file: 'src/foo.ts',
        files: ['src/foo.ts'],
        depends_on: [],
      },
      {
        id: 'T002',
        title: 'Second',
        action: 'create',
        file: 'src/bar.ts',
        files: ['src/bar.ts'],
        depends_on: ['T001'],
      },
    ]);
    for (const text of [
      '### Description\nImplement the helper function for string trimming.',
      '### Implementation Steps\n1. first step\n2. second step',
      '- assertion one\n- assertion two',
      '- no side effects\n- pure function',
      '**In bounds:**\n- only foo.ts',
      '**Out of bounds:**\n- do not touch bar.ts',
      '**Approved out of bounds:**\n- src/shared.ts',
      '- stop on ambiguity',
      '- npm test passes',
      'Follow the existing parseConfig(raw) guard shape.',
    ]) {
      expect(markdown).toContain(text);
    }
  });

  it('wraps signature, currentCode, and typeDefs in code fences', () => {
    const task = makeTask({
      action: 'modify',
      signature: 'export function greet(name: string): string',
      currentCode: 'export function old(): void {}',
      typeDefs: 'export type Foo = { bar: string };',
    });

    const markdown = formatTasks([task]);
    const signatureFenced = markdown.slice(
      markdown.indexOf('### Signature'),
      markdown.indexOf('### Current Code'),
    );

    expect(signatureFenced).toContain('```\nexport function greet(name: string): string\n```');
    expect(markdown).toContain('```\nexport function old(): void {}\n```');
    expect(markdown).toContain('```\nexport type Foo = { bar: string };\n```');
  });

  it('fences code that itself contains a triple-backtick block with a longer fence', () => {
    const currentCode = 'const md = `\n```js\nfoo()\n```\n`;';
    const task = makeTask({ action: 'modify', currentCode });

    expect(formatTasks([task])).toContain(`\`\`\`\`\n${currentCode}\n\`\`\`\``);
  });

  it.each([
    ['colon', 'Fix: parse the frontmatter'],
    ['hash', '#42 rename the module'],
    ['double quote', 'Wrap "title" in quotes'],
    ['single quote', "Don't break the parser"],
    ['leading dash', '- not a list item'],
    ['trailing space', 'title with trailing space '],
    ['line break', 'first line\nsecond line: with colon and "quotes"'],
  ] as const)('quotes a title YAML would misread (%s)', (_name, title) => {
    expect(headers(formatTasks([makeTask({ id: 'T001', title })]))).toMatchObject([{ title }]);
  });

  it.each([
    ['colon', 'src/weird: name.ts'],
    ['comma', 'data/a,b.csv'],
    ['bracket', 'app/[slug]/page.tsx'],
  ] as const)('quotes a file path YAML would misread (%s)', (_name, path) => {
    const files: [string, ...string[]] = [path, 'src/c.ts'];

    expect(headers(formatTasks([makeTask({ id: 'T001', suggestedFiles: files })]))).toMatchObject([
      { file: path, files },
    ]);
  });
});
