import { describe, expect, it } from 'vitest';
import {
  admitPlanningArtifact,
  planningArtifactError,
  type PlanningArtifactPhase,
} from './planning-artifact-admission.js';

const emptyArtifacts: Array<{ phase: PlanningArtifactPhase; filename: string; text: string }> = [
  { phase: 'specifying', filename: 'spec.md', text: '' },
  { phase: 'planning', filename: 'plan.md', text: ' \n\t' },
];

const proseArtifacts: Array<{ phase: PlanningArtifactPhase; filename: string }> = [
  { phase: 'specifying', filename: 'spec.md' },
  { phase: 'planning', filename: 'plan.md' },
];

describe('planning artifact admission', () => {
  it.each(emptyArtifacts)('rejects an empty $filename', ({ phase, filename, text }) => {
    expect(() => admitPlanningArtifact({ phase, filename, text })).toThrowError(
      expect.objectContaining({
        kind: 'planning-invalid-artifact',
        data: { phase, filename, missingShape: 'non-empty Markdown' },
      }),
    );
  });

  it.each(proseArtifacts)('rejects heading-free prose in $filename', ({ phase, filename }) => {
    expect(() =>
      admitPlanningArtifact({
        phase,
        filename,
        text: 'Which scope should tasks.md cover?\nPlease explain the intended boundaries.',
      }),
    ).toThrowError(
      expect.objectContaining({
        kind: 'planning-invalid-artifact',
        message: expect.stringContaining(`${phase} artifact ${filename}`),
        data: { phase, filename, missingShape: 'Markdown heading' },
      }),
    );
  });

  it('accepts headed Markdown and returns the resolved text', () => {
    const text = '# Specification\n\nBuild the requested feature.';

    expect(admitPlanningArtifact({ phase: 'specifying', filename: 'spec.md', text })).toBe(text);
  });

  it.each([
    {
      name: 'document frontmatter only',
      text: ['---', 'title: Specification', 'owner: planner', '---'].join('\n'),
    },
    {
      name: 'a heading inside document frontmatter',
      text: ['---', '# Hidden heading', '---'].join('\n'),
    },
    {
      name: 'task metadata followed by prose',
      text: [
        '---',
        'id: T001',
        'title: Add admission coverage',
        'action: modify',
        'file: src/engine/spec/planning-artifact-admission.ts',
        'depends_on: []',
        '---',
        'This is not a heading.',
      ].join('\n'),
    },
  ])('rejects $name without a visible heading', ({ text }) => {
    expect(() =>
      admitPlanningArtifact({ phase: 'planning', filename: 'plan.md', text }),
    ).toThrowError(
      expect.objectContaining({
        kind: 'planning-invalid-artifact',
        data: { phase: 'planning', filename: 'plan.md', missingShape: 'Markdown heading' },
      }),
    );
  });

  it.each(['# ATX heading', '   ### indented ATX heading', '#'])(
    'accepts a visible ATX heading: %s',
    (text) => {
      expect(admitPlanningArtifact({ phase: 'planning', filename: 'plan.md', text })).toBe(text);
    },
  );

  it.each(['Setext heading\n===', '   Setext heading\n   ---', '   Setext heading\n   ==='])(
    'accepts a visible Setext heading: %s',
    (text) => {
      expect(admitPlanningArtifact({ phase: 'planning', filename: 'plan.md', text })).toBe(text);
    },
  );

  it('accepts a valid clarification marker embedded in headed Markdown', () => {
    const text =
      '<!-- Q:{"id":"scope","type":"input","text":"Which scope should tasks.md cover?"} -->\n\n# Plan\n\nUse the selected scope.';

    expect(admitPlanningArtifact({ phase: 'planning', filename: 'plan.md', text })).toBe(text);
  });

  it.each([
    {
      name: 'an unterminated backtick fence after a pseudo-close with info text',
      text: ['```text', '```not-a-close', '# fake heading inside code'].join('\n'),
    },
    {
      name: 'an unterminated tilde fence after a pseudo-close with info text',
      text: ['~~~text', '~~~not-a-close', '# fake heading inside code'].join('\n'),
    },
    {
      name: 'a multiline HTML comment',
      text: ['<!--', '# fake heading inside comment', '-->'].join('\n'),
    },
    {
      name: 'a mismatched fence marker',
      text: ['```', '# fake heading inside code', '~~~', '# still inside code'].join('\n'),
    },
    {
      name: 'a shorter closing fence',
      text: ['````', '# fake heading inside code', '```', '# still inside code'].join('\n'),
    },
    {
      name: 'a closing fence with info text',
      text: ['```', '# fake heading inside code', '```text', '# still inside code'].join('\n'),
    },
  ])('rejects $name when its only heading is non-rendered', ({ text }) => {
    expect(() =>
      admitPlanningArtifact({ phase: 'planning', filename: 'plan.md', text }),
    ).toThrowError(
      expect.objectContaining({
        kind: 'planning-invalid-artifact',
        data: { phase: 'planning', filename: 'plan.md', missingShape: 'Markdown heading' },
      }),
    );
  });

  it.each([
    { marker: '```text', close: '```' },
    { marker: '~~~text', close: '~~~' },
  ])('accepts a real heading after a valid $marker close', ({ marker, close }) => {
    const text = [marker, '# fake heading inside code', `  ${close} \t`, '# Real heading'].join(
      '\n',
    );

    expect(admitPlanningArtifact({ phase: 'planning', filename: 'plan.md', text })).toBe(text);
  });

  it('accepts a real heading after a closed multiline HTML comment', () => {
    const text = ['<!--', '# fake heading inside comment', '-->', '# Real heading'].join('\n');

    expect(admitPlanningArtifact({ phase: 'planning', filename: 'plan.md', text })).toBe(text);
  });

  it('does not open a fence from inside an HTML comment', () => {
    const text = ['<!--', '```', '-->', '# Real heading'].join('\n');

    expect(admitPlanningArtifact({ phase: 'planning', filename: 'plan.md', text })).toBe(text);
  });

  it('does not treat a four-space-indented fence-looking line as a fence opener', () => {
    const text = ['    ```text', '# Real heading'].join('\n');

    expect(admitPlanningArtifact({ phase: 'planning', filename: 'plan.md', text })).toBe(text);
  });

  it('treats a three-space-indented fence as a fence opener', () => {
    const text = ['   ```text', '# fake heading inside code'].join('\n');

    expect(() =>
      admitPlanningArtifact({ phase: 'planning', filename: 'plan.md', text }),
    ).toThrowError(
      expect.objectContaining({
        kind: 'planning-invalid-artifact',
        data: { phase: 'planning', filename: 'plan.md', missingShape: 'Markdown heading' },
      }),
    );
  });

  it('exposes a typed error factory without retaining rejected content', () => {
    const failure = planningArtifactError.invalid({
      phase: 'specifying',
      filename: 'spec.md',
      missingShape: 'Markdown heading',
    });

    expect(failure.kind).toBe('planning-invalid-artifact');
    expect(failure.data).toEqual({
      phase: 'specifying',
      filename: 'spec.md',
      missingShape: 'Markdown heading',
    });
    expect(failure.message).not.toContain('Which scope');
  });
});
