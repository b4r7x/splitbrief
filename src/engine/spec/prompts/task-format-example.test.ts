import { describe, it, expect } from 'vitest';
import { formatTasks } from '../formatter.js';
import { parseTasks, parseTasksStrict } from '../tasks/parse.js';
import { buildLanguageContext } from './language-context.js';
import { buildTaskFormatExample } from './task-format-example.js';

describe('buildTaskFormatExample round-trip', () => {
  it('parses back into one task with the id the example shows', () => {
    const tasks = parseTasks(buildTaskFormatExample());

    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe('T001');
    expect(tasks[0]?.action).toBe('create');
    expect(tasks[0]?.dependsOn).toEqual([]);
  });

  it.each([
    'typescript',
    'javascript',
    'python',
    'go',
    'rust',
  ])('parses back into one task for a %s project', (language) => {
    const ctx = buildLanguageContext(language);
    const tasks = parseTasks(buildTaskFormatExample(ctx));

    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe('T001');
    expect(tasks[0]?.file).toBe(`src/path/to/file${ctx.fileExtension}`);
  });

  it('survives parseTasksStrict without a single warning', () => {
    const warnings: string[] = [];
    const tasks = parseTasksStrict(
      buildTaskFormatExample(buildLanguageContext('typescript')),
      (message) => warnings.push(message),
    );

    expect(tasks).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it('shows code fences the section extractor can actually read', () => {
    const tasks = parseTasks(buildTaskFormatExample(buildLanguageContext('typescript')));

    expect(tasks[0]?.signature).toBe('export function exampleFn(param: Type): ReturnType');
    expect(tasks[0]?.typeDefs).toBe('// All referenced types, copied verbatim');
    expect(tasks[0]?.currentCode).toBe('// Relevant existing code for modify tasks');
  });

  it('fills every Task Brief section the example advertises', () => {
    const task = parseTasks(buildTaskFormatExample())[0];

    expect(task?.description).toContain('What to implement and why');
    expect(task?.pattern).toContain('Existing codebase pattern');
    expect(task?.implementationSteps).toHaveLength(3);
    expect(task?.tests).toEqual(['Test case with concrete inputs/outputs']);
    expect(task?.scope?.inBounds).toEqual(['Concrete change this brief is allowed to make']);
    expect(task?.scope?.outOfBounds).toEqual(['Adjacent change the implementer must NOT make']);
    expect(task?.scope?.approvedOutOfBounds).toHaveLength(1);
    expect(task?.escalation).toHaveLength(1);
    expect(task?.evidence).toHaveLength(1);
    expect(task?.constraints).toHaveLength(2);
  });

  it('survives the formatter the product writes tasks.md with', () => {
    const parsed = parseTasksStrict(buildTaskFormatExample(buildLanguageContext('typescript')));

    expect(parseTasksStrict(formatTasks(parsed))).toEqual(parsed);
  });

  it('states field vocabularies in prose instead of alternations in the specimen', () => {
    const example = buildTaskFormatExample();

    expect(example).not.toContain('action: create | modify');
    expect(example).not.toContain('depends_on: [] | [T001, T002]');
    expect(example).toContain('`action` — exactly `create` or `modify`.');
    expect(example).toContain('`[T001, T002]` when it must run after both');
  });

  it('is not wrapped in a code fence of its own', () => {
    expect(buildTaskFormatExample().trimStart().startsWith('```')).toBe(false);
  });
});
