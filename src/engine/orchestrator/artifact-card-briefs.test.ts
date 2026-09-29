import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { TASKS_FILE } from '../../core/paths.js';
import { formatTasks } from '../spec/formatter.js';
import { parseTaskSourceBlocks } from '../spec/tasks/parse.js';
import { buildArtifactExcerpt } from './artifact-card.js';

const briefFixtures = join(import.meta.dirname, '../../../testing/fixtures/briefs');
const briefCaptures = readdirSync(briefFixtures).filter((file) => file.endsWith('.md'));

describe('buildArtifactExcerpt — every brief the parser reads', () => {
  // Run 2's tasks.md (2026-09-25) verbatim: T004 and T006 with a brief on each side, each body cut
  // after its first description line. The headers are exact, 13 and 14 lines for T004 and T006; the
  // card listed T003, T005 and T007 and said nothing was missing.
  it('lists every brief of a tasks.md whose headers run past twelve lines', () => {
    const text = readFileSync(join(briefFixtures, 'standard-long-frontmatter-tasks.md'), 'utf-8');

    const result = buildArtifactExcerpt(text, TASKS_FILE);

    expect(result.excerpt).toEqual([
      "T003  Keep the owner's committed files out of drift analysis",
      'T004  Report committed-only files and pass them to drift at the final review',
      "T005  Count a direct writer's promoted lines in implementer_generate_done",
      'T006  Hand the workspace snapshot to every direct-writer implementer call',
      'T007  Stop naming promoted files as unpromoted leftovers at a fresh reseed',
    ]);
    expect(result.omittedUnit).toBe('task');
    expect(result.omittedCount).toBe(0);
  });

  // The card previews the list the run executes, so it accounts for exactly the briefs the parser
  // reads: past the `---` rules planners write before phase headings, and out of a fenced reply.
  it.each(briefCaptures)('accounts for every brief the parser reads from %s', (name) => {
    const text = readFileSync(join(briefFixtures, name), 'utf-8');
    const parsed = parseTaskSourceBlocks(text).map((block) => block.id);

    const result = buildArtifactExcerpt(text, TASKS_FILE);

    expect(result.omittedUnit).toBe('task');
    expect(result.excerpt.map((row) => row.split('  ')[0])).toEqual(
      parsed.slice(0, result.excerpt.length),
    );
    expect(result.excerpt.length + result.omittedCount).toBe(parsed.length);
  });

  it('reads a header to its closing delimiter however many files it declares', () => {
    const files = Array.from({ length: 20 }, (_, index) => `src/${index}.ts`);
    const text = formatTasks([
      makeTask({ id: 'T001', title: 'Touch twenty files', file: 'src/0.ts', files }),
      makeTask({ id: 'T002', title: 'Touch one file', file: 'src/one.ts' }),
    ]);

    const result = buildArtifactExcerpt(text, TASKS_FILE);

    expect(result.excerpt).toEqual(['T001  Touch twenty files', 'T002  Touch one file']);
    expect(result.omittedCount).toBe(0);
  });

  // `formatTasks` writes a description verbatim, so a sample the planner opened and never closed
  // reaches `tasks.md`. The parser ends it at the next brief even when a later brief carries a
  // sample of its own; the card listed T001 alone and said nothing was missing.
  it('lists the briefs after one whose body never closes its code sample', () => {
    const text = formatTasks([
      makeTask({
        id: 'T001',
        title: 'Cut the sample short',
        file: 'src/limit.ts',
        description: 'Before:\n```ts\nconst limit = 12;',
      }),
      makeTask({ id: 'T002', title: 'Read past the sample', file: 'src/read.ts' }),
      makeTask({
        id: 'T003',
        title: 'Sign the reader',
        file: 'src/sign.ts',
        signature: 'export function read(): string',
      }),
    ]);

    const result = buildArtifactExcerpt(text, TASKS_FILE);

    expect(parseTaskSourceBlocks(text).map((block) => block.id)).toEqual(['T001', 'T002', 'T003']);
    expect(result.excerpt).toEqual([
      'T001  Cut the sample short',
      'T002  Read past the sample',
      'T003  Sign the reader',
    ]);
    expect(result.omittedCount).toBe(0);
  });

  it('reads a tasks.md with CRLF line endings as it reads the same file with LF', () => {
    const text = readFileSync(join(briefFixtures, 'standard-long-frontmatter-tasks.md'), 'utf-8');

    expect(buildArtifactExcerpt(text.replace(/\n/g, '\r\n'), TASKS_FILE)).toEqual(
      buildArtifactExcerpt(text, TASKS_FILE),
    );
  });

  it('splits a brief separator glued to the line before it, as the parser does', () => {
    const first = formatTasks([makeTask({ id: 'T001', title: 'Glue the rule', file: 'src/a.ts' })]);
    const second = formatTasks([makeTask({ id: 'T002', title: 'Follow it', file: 'src/b.ts' })]);
    const text = `${first}${second}`;

    const result = buildArtifactExcerpt(text, TASKS_FILE);

    expect(text).toContain('greeting---\nid: T002');
    expect(parseTaskSourceBlocks(text).map((block) => block.id)).toEqual(['T001', 'T002']);
    expect(result.excerpt).toEqual(['T001  Glue the rule', 'T002  Follow it']);
  });

  it('reads a title YAML writes as a block scalar or on the line below its key', () => {
    const brief = (id: string, title: readonly string[]): string[] => [
      '---',
      `id: ${id}`,
      ...title,
      'action: modify',
      `file: src/${id}.ts`,
      'depends_on: []',
      '---',
      '',
      '### Description',
      `Brief ${id}.`,
    ];
    const text = [
      ...brief('T001', ['title: >-', '  Fold a long title', '  onto two lines']),
      ...brief('T002', ['title: |', '  Keep a literal title', '  on two lines']),
      ...brief('T003', ['title:', '  Put the title below its key']),
    ].join('\n');

    const result = buildArtifactExcerpt(text, TASKS_FILE);

    expect(result.excerpt).toEqual([
      'T001  Fold a long title onto two lines',
      'T002  Keep a literal title on two lines',
      'T003  Put the title below its key',
    ]);
  });

  // A header the parser rejects never reaches a run: the strict parse refuses the document before
  // `tasks.md` is announced. So it is not a brief the card has left out.
  it('counts the briefs the parser reads, not a header it rejects', () => {
    const untitled = ['---', 'id: T001', 'title:', 'action: create', 'file: src/a.ts', '---'];
    const plain = makeTask({ id: 'T002', title: 'Keep the one-line title', file: 'src/plain.ts' });
    const text = [...untitled, formatTasks([plain])].join('\n');

    const result = buildArtifactExcerpt(text, TASKS_FILE);

    expect(parseTaskSourceBlocks(text).map((block) => block.id)).toEqual(['T002']);
    expect(result.excerpt).toEqual(['T002  Keep the one-line title']);
    expect(result.omittedUnit).toBe('task');
    expect(result.omittedCount).toBe(0);
  });
});
