import { describe, it, expect } from 'vitest';
import { formatTasks } from './formatter.js';
import { parseTasks, parseTasksStrict } from './tasks/parse.js';
import { makeTask as makeBaseTask } from '#testing/helpers/factories/task.js';

type TaskOverrides = Parameters<typeof makeBaseTask>[0];

function makeTask(overrides: TaskOverrides = {}): ReturnType<typeof makeBaseTask> {
  return makeBaseTask({
    title: 'Create utility module',
    file: 'src/utils/helpers.ts',
    description: 'Implement helper functions for string manipulation.',
    ...overrides,
  });
}

describe('formatTasks', () => {
  it('handles the empty boundary', () => {
    expect(formatTasks([])).toBe('');
    expect(parseTasks('')).toEqual([]);
  });

  it('round-trips ordered tasks with metadata and optional brief fields', () => {
    const first = makeTask({
      id: 'T001',
      title: 'My Task',
      action: 'modify',
      file: 'src/foo.ts',
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
      typeDefs: 'export type Foo = { bar: string };',
      signature: 'export function greet(name: string): string',
      currentCode: 'export function old(): void {}',
      pattern: 'Follow the existing parseConfig(raw) guard shape.',
    });
    const second = makeBaseTask({
      id: 'T002',
      title: 'Second',
      file: 'src/bar.ts',
      description: 'Do bar',
      dependsOn: [first.id],
      implementationSteps: ['step 2'],
      tests: ['test B'],
    });

    const parsed = parseTasks(formatTasks([first, second]));

    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      id: first.id,
      title: 'My Task',
      action: 'modify',
      file: 'src/foo.ts',
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
      typeDefs: 'export type Foo = { bar: string };',
      signature: 'export function greet(name: string): string',
      currentCode: 'export function old(): void {}',
      pattern: 'Follow the existing parseConfig(raw) guard shape.',
    });
    expect(parsed[1]).toMatchObject({
      id: second.id,
      title: 'Second',
      file: 'src/bar.ts',
      dependsOn: [first.id],
    });
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

  it('round-trips currentCode that contains heading and separator lines', () => {
    const currentCode =
      'export function old() {\n  return `---`;\n}\n### not a real heading\n--- not a separator';
    const task = makeTask({
      action: 'modify',
      currentCode,
      typeDefs: 'export type Foo = {\n  bar: string;\n};',
      signature: 'export function old(): void',
    });

    const parsed = parseTasks(formatTasks([task]));

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.currentCode).toBe(currentCode);
    expect(parsed[0]?.typeDefs).toBe('export type Foo = {\n  bar: string;\n};');
    expect(parsed[0]?.signature).toBe('export function old(): void');
  });

  it('round-trips code that itself contains a triple-backtick fenced block', () => {
    const currentCode = 'const md = `\n```js\nfoo()\n```\n`;';
    const task = makeTask({
      action: 'modify',
      currentCode,
      typeDefs: 'export type Bar = string;',
    });

    const parsed = parseTasks(formatTasks([task]));

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.currentCode).toBe(currentCode);
    expect(parsed[0]?.typeDefs).toBe('export type Bar = string;');
  });

  it.each([
    ['colon', 'Fix: parse the frontmatter'],
    ['hash', '#42 rename the module'],
    ['double quote', 'Wrap "title" in quotes'],
    ['single quote', "Don't break the parser"],
    ['leading dash', '- not a list item'],
    ['trailing space', 'title with trailing space '],
  ] as const)('strict round-trips a title needing YAML quoting (%s)', (_name, title) => {
    const task = makeTask({ id: 'T001', title });

    const parsed = parseTasksStrict(formatTasks([task]));

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.title).toBe(title);
  });

  it('strict round-trips a file path that needs YAML quoting', () => {
    const task = makeTask({ id: 'T001', file: 'src/weird: name.ts' });

    const parsed = parseTasksStrict(formatTasks([task]));

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.file).toBe('src/weird: name.ts');
  });

  it('strict round-trips a multi-line title without producing a block scalar inline', () => {
    const title = 'first line\nsecond line: with colon and "quotes"';
    const task = makeTask({ id: 'T001', title });

    const parsed = parseTasksStrict(formatTasks([task]));

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.title).toBe(title);
  });

  it('strict-parse round-trips signature/currentCode/typeDefs whose fenced bodies contain --- documents', () => {
    const signature = 'export function loadFrontmatter(raw: string): Frontmatter';
    const currentCode = ['---', 'id: T999', 'title: looks like a task', '---', 'body line'].join(
      '\n',
    );
    const typeDefs = ['export type Frontmatter = {', '  ---: never;', '};'].join('\n');
    const first = makeTask({
      id: 'T001',
      action: 'modify',
      signature,
      currentCode,
      typeDefs,
    });
    const second = makeTask({
      id: 'T002',
      title: 'Second task',
      file: 'src/second.ts',
      dependsOn: [first.id],
    });

    const parsed = parseTasksStrict(formatTasks([first, second]));

    expect(parsed.map((t) => t.id)).toEqual(['T001', 'T002']);
    expect(parsed[0]?.signature).toBe(signature);
    expect(parsed[0]?.currentCode).toBe(currentCode);
    expect(parsed[0]?.typeDefs).toBe(typeDefs);
  });
});
