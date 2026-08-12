import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { PLAN_FILE, SPEC_FILE, TASKS_FILE, sessionDir } from '../../core/paths.js';
import { buildSpecFrontmatter } from '../../core/paths-io.js';
import { getTerminalCellWidth } from '../../utils/display-text.js';
import { buildArtifactExcerpt, publishArtifactWritten } from './artifact-card.js';

function filler(label: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${label} body line ${index + 1}`);
}

function section(title: string, bodyLines: number): string[] {
  return ['', title, '', ...filler(title.replace(/\W+/g, '-'), bodyLines)];
}

describe('buildArtifactExcerpt — the document itself', () => {
  it('shows a short document whole and omits nothing', () => {
    const result = buildArtifactExcerpt('Plan\n\nDo the thing.\n', PLAN_FILE);

    expect(result).toEqual({
      lineCount: 3,
      excerpt: ['Plan', '', 'Do the thing.'],
      omittedCount: 0,
      omittedUnit: 'line',
    });
  });

  it('drops the planner’s first-person narration from a short document too', () => {
    const text = [
      'I’ll inspect the project guidance to verify whether there is a target.',
      '',
      'Provide a concrete target, such as:',
      '',
      '- Add `splitbrief logs` with specified behavior',
      '- Modify `src/cli.ts` to register a named command',
    ].join('\n');

    const result = buildArtifactExcerpt(text, TASKS_FILE);

    expect(result.excerpt).toEqual([
      'Provide a concrete target, such as:',
      '',
      '- Add `splitbrief logs` with specified behavior',
      '- Modify `src/cli.ts` to register a named command',
    ]);
    expect(result.excerpt.length + result.omittedCount).toBe(result.lineCount);
  });

  it('keeps a document that is nothing but narration, because it is all there is', () => {
    const result = buildArtifactExcerpt('I’m checking the repository guidance first.\n', SPEC_FILE);

    expect(result.excerpt).toEqual(['I’m checking the repository guidance first.']);
    expect(result.omittedCount).toBe(0);
  });

  it('strips the frontmatter SPLITBRIEF prepends to persisted artifacts', () => {
    const text = `${buildSpecFrontmatter({
      plannerTool: 'claude-code',
      implementerTool: 'codex',
      mode: 'standard',
    })}# Plan\n\nBody.\n`;
    const result = buildArtifactExcerpt(text, PLAN_FILE);

    expect(result.excerpt).toEqual(['Body.']);
    expect(result.lineCount).toBe(3);
    expect(result.omittedCount).toBe(2);
  });

  it('counts the document the reader sees, not the header SPLITBRIEF stamps on the file', () => {
    const body = `${Array.from({ length: 30 }, (_, index) => `Requirement ${index + 1}.`).join('\n\n')}\n`;
    const frontmatter = buildSpecFrontmatter({
      plannerTool: 'opencode',
      implementerTool: 'opencode',
      mode: 'standard',
    });

    const document = buildArtifactExcerpt(body, SPEC_FILE);
    const file = buildArtifactExcerpt(frontmatter + body, SPEC_FILE);

    expect(document.lineCount).toBe(59);
    expect(file.lineCount).toBe(document.lineCount);
    expect((frontmatter + body).split('\n').length).toBe(document.lineCount + 8);
  });

  it('keeps a leading rule that is not SPLITBRIEF frontmatter', () => {
    const result = buildArtifactExcerpt('---\ntitle: user notes\n---\nPlan\n', PLAN_FILE);

    expect(result.excerpt).toEqual(['---', 'title: user notes', '---', 'Plan']);
  });
});

describe('buildArtifactExcerpt — section outline', () => {
  it('lists the sections and their sizes instead of the opening narration', () => {
    const lines = [
      'I’ll trace the provider path, then report the gaps without modifying files.',
      ...section('### Architecture', 6),
      ...section('### Relevant Code', 6),
      ...section('### Validation Tools', 2),
    ];

    const result = buildArtifactExcerpt(lines.join('\n'), 'research.md');

    expect(result.excerpt).toEqual([
      'Architecture      9 lines',
      'Relevant Code     9 lines',
      'Validation Tools  4 lines',
    ]);
    expect(result.omittedUnit).toBe('section');
    expect(result.omittedCount).toBe(0);
  });

  it('nests the level below when the whole nested outline fits', () => {
    const lines = [
      ...section('## Overview', 4),
      ...section('## Functional Requirements', 2),
      ...section('### Inputs', 6),
      ...section('### Outputs', 6),
      ...section('## Out of Scope', 4),
    ];

    const result = buildArtifactExcerpt(lines.join('\n'), SPEC_FILE);

    expect(result.excerpt).toEqual([
      'Overview                  7 lines',
      'Functional Requirements  23 lines',
      '  Inputs                  9 lines',
      '  Outputs                 9 lines',
      'Out of Scope              6 lines',
    ]);
    expect(result.omittedCount).toBe(0);
  });

  it('keeps the top level complete rather than nesting half of it', () => {
    const lines = Array.from({ length: 6 }, (_, index) => [
      ...section(`## Section ${index + 1}`, 1),
      ...section(`### Child ${index * 2 + 1}`, 1),
      ...section(`### Child ${index * 2 + 2}`, 1),
    ]).flat();

    const result = buildArtifactExcerpt(lines.join('\n'), PLAN_FILE);

    expect(result.excerpt.map((row) => row.split('  ')[0])).toEqual([
      'Section 1',
      'Section 2',
      'Section 3',
      'Section 4',
      'Section 5',
      'Section 6',
    ]);
    // The twelve children it declined to nest are still sections it is not showing.
    expect(result.omittedUnit).toBe('section');
    expect(result.omittedCount).toBe(12);
  });

  it('counts the sections it could not show, not the lines', () => {
    const lines = Array.from({ length: 14 }, (_, index) =>
      section(`## Section ${index + 1}`, 2),
    ).flat();

    const result = buildArtifactExcerpt(lines.join('\n'), PLAN_FILE);

    expect(result.excerpt).toHaveLength(10);
    expect(result.omittedUnit).toBe('section');
    expect(result.excerpt.length + result.omittedCount).toBe(14);
  });

  it('skips a heading level whose titles repeat, because it is a per-section template', () => {
    const lines = [
      ...section('## Brief', 4),
      ...section('### First', 4),
      ...section('## Brief', 1),
      ...section('### Second', 4),
    ];

    const result = buildArtifactExcerpt(lines.join('\n'), TASKS_FILE);

    expect(result.excerpt.map((row) => row.split('  ')[0])).toEqual(['First', 'Second']);
  });

  it('drops a heading that only echoes the artifact filename', () => {
    const lines = [
      '# tasks.md',
      ...section('## Phase one', 6),
      ...section('## Phase two', 6),
      ...section('## Phase three', 6),
    ];

    const result = buildArtifactExcerpt(lines.join('\n'), TASKS_FILE);

    expect(result.excerpt.map((row) => row.split('  ')[0])).toEqual([
      'Phase one',
      'Phase two',
      'Phase three',
    ]);
  });

  it('ignores headings inside a fenced sample', () => {
    const lines = [
      ...section('## Overview', 4),
      '```md',
      '# Not a heading',
      '## Also not a heading',
      '```',
      ...section('## Details', 6),
    ];

    const result = buildArtifactExcerpt(lines.join('\n'), SPEC_FILE);

    expect(result.excerpt.map((row) => row.split('  ')[0])).toEqual(['Overview', 'Details']);
  });

  it('reads through a fence the planner wrapped around the whole reply', () => {
    const lines = [
      'I’ll draft the specification now.',
      '',
      '```md',
      '# Ollama Cloud Integration',
      ...section('## Overview', 6),
      ...section('## Out of Scope', 4),
      '```',
    ];

    const result = buildArtifactExcerpt(lines.join('\n'), SPEC_FILE);

    expect(result.excerpt.map((row) => row.split('  ')[0])).toEqual(['Overview', 'Out of Scope']);
  });
});

describe('buildArtifactExcerpt — Task Brief outline', () => {
  const brief = (id: string, title: string, file: string): string[] => [
    '---',
    `id: ${id}`,
    `title: ${title}`,
    'action: create',
    `file: ${file}`,
    'depends_on: []',
    '---',
    '',
    '### Description',
    ...filler(id, 4),
    '',
  ];

  it('lists brief ids and titles rather than the brief template headings', () => {
    const lines = [
      'I’m inspecting the repository conventions before writing the briefs.',
      '',
      'Phase 1 establishes the shared tool contract.',
      '',
      ...brief('T001', 'Add API tool contract', 'src/engine/tools/types.ts'),
      ...brief('T002', '"Validate API tools and inputs"', 'src/engine/tools/validation.ts'),
    ];

    const result = buildArtifactExcerpt(lines.join('\n'), TASKS_FILE);

    expect(result.excerpt).toEqual([
      'T001  Add API tool contract',
      'T002  Validate API tools and inputs',
    ]);
    expect(result.omittedUnit).toBe('task');
    expect(result.omittedCount).toBe(0);
  });

  it('counts the briefs it could not show, not the lines', () => {
    const lines = Array.from({ length: 13 }, (_, index) =>
      brief(`T${String(index + 1).padStart(3, '0')}`, `Task ${index + 1}`, `src/${index}.ts`),
    ).flat();

    const result = buildArtifactExcerpt(lines.join('\n'), TASKS_FILE);

    expect(result.excerpt).toHaveLength(10);
    expect(result.omittedUnit).toBe('task');
    expect(result.excerpt.length + result.omittedCount).toBe(13);
  });

  it('lists a lone brief rather than the headings every brief repeats', () => {
    const lines = [
      ...brief('T001', 'Fix the startup router', 'src/cli/commands/start/register.ts'),
      '### Tests',
      ...filler('tests', 6),
    ];

    const result = buildArtifactExcerpt(lines.join('\n'), TASKS_FILE);

    expect(result.excerpt).toEqual(['T001  Fix the startup router']);
  });
});

describe('buildArtifactExcerpt — fallback slice', () => {
  it('slices from the top when the document has no structure at all', () => {
    const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);

    const result = buildArtifactExcerpt(lines.join('\n'), 'research.md');

    expect(result.excerpt).toEqual(lines.slice(0, 10));
    expect(result.omittedUnit).toBe('line');
    expect(result.excerpt.length + result.omittedCount).toBe(result.lineCount);
  });

  it('falls back to a slice when neither briefs nor headings parse', () => {
    const lines = [
      '---',
      'id: T001',
      'action: create',
      '---',
      '### Description',
      ...filler('desc', 5),
      '### Description',
      ...filler('more', 5),
    ];

    const result = buildArtifactExcerpt(lines.join('\n'), TASKS_FILE);

    expect(result.excerpt).toEqual([
      'Description',
      ...filler('desc', 5).map((line) => `  ${line}`),
      'Description',
      ...filler('more', 3).map((line) => `  ${line}`),
    ]);
    expect(result.excerpt.length + result.omittedCount).toBe(result.lineCount);
  });

  it('starts at the first heading and indents what sits under it', () => {
    const lines = [
      'This is the brief-compilation phase of a run whose input was a greeting.',
      '',
      '# tasks.md',
      '',
      '## Phase 0 — Blocked: no feature to compile',
      '',
      '**Purpose:** carry the pipeline halt through brief compilation.',
      ...filler('body', 12),
    ];

    const result = buildArtifactExcerpt(lines.join('\n'), TASKS_FILE);

    expect(result.excerpt.slice(0, 4)).toEqual([
      'Phase 0 — Blocked: no feature to compile',
      '',
      '  Purpose: carry the pipeline halt through brief compilation.',
      '  body body line 1',
    ]);
    expect(result.excerpt.length + result.omittedCount).toBe(result.lineCount);
  });

  it('keeps the slice at the top when the first heading is past the preview', () => {
    const lines = [...filler('intro', 12), '## Only heading', ...filler('rest', 3)];

    const result = buildArtifactExcerpt(lines.join('\n'), PLAN_FILE);

    expect(result.excerpt).toEqual(filler('intro', 10));
  });

  it('keeps the ASCII fallback cap at 200 terminal cells', () => {
    const line = 'a'.repeat(201);
    const result = buildArtifactExcerpt([line, ...filler('rest', 10)].join('\n'), PLAN_FILE);

    expect(result.excerpt[0]).toBe('a'.repeat(200));
    expect(getTerminalCellWidth(result.excerpt[0] ?? '')).toBe(200);
  });

  it('does not split CJK, ZWJ, family emoji, or surrogate pairs in fallback lines', () => {
    const family = '👩‍👩‍👧‍👦';
    const result = buildArtifactExcerpt(
      [`${'界'.repeat(101)}${family}`, ...filler('rest', 10)].join('\n'),
      PLAN_FILE,
    );

    expect(result.excerpt[0]).toBe('界'.repeat(100));
    expect(result.excerpt[0]).not.toContain('\ud800');
    expect(result.excerpt[0]).not.toContain('\udc00');
    expect(getTerminalCellWidth(result.excerpt[0] ?? '')).toBe(200);
  });
});

describe('buildArtifactExcerpt — display-cell caps', () => {
  it('caps wide CJK titles at the terminal-cell budget', () => {
    const title = '界'.repeat(30);
    const lines = [
      ...section(`## ${title}`, 2),
      ...section('## Other section', 2),
      ...section('## Final section', 2),
    ];

    const result = buildArtifactExcerpt(lines.join('\n'), PLAN_FILE);

    expect(result.excerpt[0]?.startsWith(`${'界'.repeat(21)}…`)).toBe(true);
    expect(getTerminalCellWidth(result.excerpt[0] ?? '')).toBeLessThanOrEqual(60);
  });

  it('keeps ZWJ family emoji titles whole at the terminal-cell budget', () => {
    const family = '👩‍👩‍👧‍👦';
    const lines = [
      ...section(`## ${family.repeat(30)}`, 2),
      ...section('## Other section', 2),
      ...section('## Final section', 2),
    ];

    const result = buildArtifactExcerpt(lines.join('\n'), PLAN_FILE);

    expect(result.excerpt[0]?.startsWith(`${family.repeat(21)}…`)).toBe(true);
    expect(result.excerpt[0]).not.toContain(`${family.slice(0, -2)}…`);
  });
});

describe('buildArtifactExcerpt — inline emphasis', () => {
  const excerptOf = (line: string): string | undefined =>
    buildArtifactExcerpt(line, PLAN_FILE).excerpt[0];

  it('removes paired emphasis markers without interpreting them', () => {
    expect(excerptOf('- **Brief count:** 0')).toBe('- Brief count: 0');
    expect(excerptOf('a *stressed* word and an __emphatic__ one')).toBe(
      'a stressed word and an emphatic one',
    );
    expect(excerptOf('_leading_ emphasis')).toBe('leading emphasis');
  });

  it('leaves markers alone inside code spans, inside words, and when unpaired', () => {
    expect(excerptOf('publishes `tasks_planned` and **counts** it')).toBe(
      'publishes `tasks_planned` and counts it',
    );
    expect(excerptOf('the event tasks_planned fires once')).toBe(
      'the event tasks_planned fires once',
    );
    expect(excerptOf('`a * b` times **c**')).toBe('`a * b` times c');
    expect(excerptOf('an **unclosed pair stays')).toBe('an **unclosed pair stays');
  });

  it('leaves a fenced code sample exactly as written', () => {
    const lines = [
      '## Signature',
      '',
      '```ts',
      'const weight = a ** b;',
      'const name = task_id;',
      '```',
      ...filler('after', 10),
    ];

    const result = buildArtifactExcerpt(lines.join('\n'), PLAN_FILE);

    expect(result.excerpt).toContain('  const weight = a ** b;');
    expect(result.excerpt).toContain('  const name = task_id;');
  });
});

describe('publishArtifactWritten', () => {
  it('publishes the session artifact path, line count and excerpt', () => {
    const { bus, events } = makeBusRecorder();

    publishArtifactWritten({
      bus,
      phase: 'planning',
      projectDir: '/proj',
      sessionId: 'sess-1',
      filename: PLAN_FILE,
      text: '# Plan\n\nBody.\n',
    });

    expect(events).toEqual([
      {
        type: 'artifact_written',
        ts: expect.any(Number),
        phase: 'planning',
        filename: PLAN_FILE,
        path: join(sessionDir('/proj', 'sess-1'), PLAN_FILE),
        lineCount: 3,
        excerpt: ['Body.'],
        omittedCount: 2,
        omittedUnit: 'line',
      },
    ]);
  });

  it('publishes nothing for an empty artifact', () => {
    const { bus, events } = makeBusRecorder();

    publishArtifactWritten({
      bus,
      phase: 'planning',
      projectDir: '/proj',
      sessionId: 'sess-1',
      filename: PLAN_FILE,
      text: '\n\n',
    });

    expect(events).toEqual([]);
  });
});
