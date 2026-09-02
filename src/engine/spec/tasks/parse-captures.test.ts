import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { dependencyTaskBlock } from '#testing/helpers/factories/task.js';
import { evaluateBriefQuality } from '../brief-quality.js';
import { parseTasks, parseTaskSourceBlocks, parseTasksStrict } from './parse.js';

describe('parseTasks — real planner captures', () => {
  const briefFixtures = join(import.meta.dirname, '../../../../testing/fixtures/briefs');
  const codexFixture = readFileSync(
    join(briefFixtures, 'codex-standard-phase-separators.md'),
    'utf-8',
  );
  const opencodeFixture = readFileSync(
    join(briefFixtures, 'opencode-trailing-separator-prose.md'),
    'utf-8',
  );

  it('parses both real captures to their pinned ids in lenient and strict mode', () => {
    const cases = [
      { fixture: codexFixture, ids: ['T001', 'T002'] },
      { fixture: opencodeFixture, ids: ['T001'] },
    ];

    for (const { fixture, ids } of cases) {
      const lenientWarnings: string[] = [];
      const strictWarnings: string[] = [];
      const lenient = parseTasks(fixture, {
        onWarning: (message) => lenientWarnings.push(message),
      });
      const strict = parseTasksStrict(fixture, (message) => strictWarnings.push(message));

      expect(lenient.map((t) => t.id)).toEqual(ids);
      expect(strict.map((t) => t.id)).toEqual(ids);
      expect(lenientWarnings).toEqual([]);
      expect(strictWarnings).toEqual([]);
      expect(parseTaskSourceBlocks(fixture).map((b) => b.id)).toEqual(ids);
    }
  });
});

describe('parseTasks — fenced planner replies', () => {
  const briefFixtures = join(import.meta.dirname, '../../../../testing/fixtures/briefs');

  // Captured verbatim from a 2026-08-06 quick run: the planner answered with prose
  // narration and the whole tasks.md inside a ````markdown fence (four backticks,
  // because the briefs carry ```typescript fences of their own). The shipped parser
  // returned zero tasks for it and the run died before the implementer started.
  const capturedReply = readFileSync(join(briefFixtures, 'run-a-fenced-planner-reply.md'), 'utf-8');

  it('parses the captured fenced reply to T001 and T002 with no warning', () => {
    const warnings: string[] = [];
    const tasks = parseTasks(capturedReply, { onWarning: (message) => warnings.push(message) });

    expect(tasks.map((t) => t.id)).toEqual(['T001', 'T002']);
    expect(warnings).toEqual([]);
    const t1 = tasks[0];
    expect(t1?.file).toBe('src/text.ts');
    expect(t1?.signature).toBe('export function titleCase(input: string): string');
    expect(t1?.currentCode).toContain('export function slugify(input: string): string');
    expect(tasks[1]?.dependsOn).toEqual(['T001']);
  });

  it('parses the captured fenced reply in strict mode without throwing or warning', () => {
    const warnings: string[] = [];
    const tasks = parseTasksStrict(capturedReply, (message) => warnings.push(message));

    expect(tasks.map((t) => t.id)).toEqual(['T001', 'T002']);
    expect(warnings).toEqual([]);
  });

  it('keeps every unwrapped brief a verbatim substring of the captured reply', () => {
    const blocks = parseTaskSourceBlocks(capturedReply);

    expect(blocks.map((b) => b.id)).toEqual(['T001', 'T002']);
    for (const block of blocks) {
      expect(capturedReply).toContain(block.source);
      expect(block.source).not.toContain('````');
    }
    expect(blocks[0]?.source).toContain(
      '```typescript\nexport function titleCase(input: string): string\n```',
    );
  });

  it('returns brief sources byte-identical to the input when nothing wraps the document', () => {
    const input = [
      '---',
      'id: T101',
      'title: "Inner fences are content"',
      'action: create',
      'file: src/a.ts',
      'depends_on: []',
      '---',
      '',
      '### Description',
      'A brief whose sections carry their own fences.',
      '',
      '### Current Code',
      '```yaml',
      '---',
      'key: value',
      '---',
      '```',
    ].join('\n');

    const blocks = parseTaskSourceBlocks(input);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.source).toBe(input);
  });

  it('selects the task-shaped region when narration carries other fenced snippets too', () => {
    const input = [
      'First I would run:',
      '```bash',
      'npm test',
      '```',
      'And here are the briefs:',
      '````markdown',
      dependencyTaskBlock('T001').trimEnd(),
      '````',
      'Let me know if you need adjustments.',
    ].join('\n');
    const warnings: string[] = [];
    const tasks = parseTasks(input, { onWarning: (message) => warnings.push(message) });

    expect(tasks.map((t) => t.id)).toEqual(['T001']);
    expect(warnings).toEqual([]);
  });

  it('parses a wrapper fence the planner never closed', () => {
    const input = `Here is the complete tasks.md content:\n\n\`\`\`\`markdown\n${dependencyTaskBlock('T001')}`;
    const warnings: string[] = [];
    const tasks = parseTasks(input, { onWarning: (message) => warnings.push(message) });

    expect(tasks.map((t) => t.id)).toEqual(['T001']);
    expect(warnings).toEqual([]);
  });

  // Captured verbatim from a 2026-08-07 instant run: the planner wrapped the whole
  // tasks.md in a ```markdown fence exactly as long as the ```javascript fences its
  // own briefs carry. The shipped parser returned T001 with every section after
  // `### Signature` missing, and the brief quality gate failed the run with five
  // errors before the implementer started.
  const sameLengthReply = readFileSync(
    join(briefFixtures, 'run-b-same-length-fenced-planner-reply.md'),
    'utf-8',
  );

  it('keeps every section of a wrapper fence as long as the brief its own fences', () => {
    const warnings: string[] = [];
    const tasks = parseTasks(sameLengthReply, { onWarning: (message) => warnings.push(message) });

    expect(tasks.map((t) => t.id)).toEqual(['T001']);
    expect(warnings).toEqual([]);
    const task = tasks[0];
    expect(task?.file).toBe('hello.js');
    expect(task?.currentCode).toContain('export function hello()');
    expect(task?.implementationSteps.length).toBeGreaterThan(0);
    expect(task?.tests.length).toBeGreaterThan(0);
    expect(task?.evidence?.length).toBeGreaterThan(0);
    expect(task?.scope?.inBounds?.length).toBeGreaterThan(0);
    expect(task?.scope?.outOfBounds?.length).toBeGreaterThan(0);
  });

  it('carries the same-length fenced reply past the brief quality gate', () => {
    const report = evaluateBriefQuality(parseTasks(sameLengthReply));

    expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it('drops the trailing narration after a same-length wrapper fence', () => {
    const blocks = parseTaskSourceBlocks(sameLengthReply);

    expect(blocks.map((b) => b.id)).toEqual(['T001']);
    expect(blocks[0]?.source).not.toContain('I returned the content above');
    expect(blocks[0]?.source).toContain('```bash');
  });

  it('parses a fenced document even when the preamble carries a --- horizontal rule', () => {
    const input = `My plan:\n\n---\n\nHere is the tasks.md:\n\n\`\`\`\`markdown\n${dependencyTaskBlock('T001')}\`\`\`\``;
    const warnings: string[] = [];
    const tasks = parseTasks(input, { onWarning: (message) => warnings.push(message) });

    expect(tasks.map((t) => t.id)).toEqual(['T001']);
    expect(warnings).toEqual([]);

    const strictWarnings: string[] = [];
    const strictTasks = parseTasksStrict(input, (message) => strictWarnings.push(message));
    expect(strictTasks.map((t) => t.id)).toEqual(['T001']);
    expect(strictWarnings).toEqual([]);
  });
});
