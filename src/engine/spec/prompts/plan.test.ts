import { describe, it, expect } from 'vitest';
import { PLAN_PROMPT_MAX_BYTES } from '../../../core/pipeline-spec/brief.js';
import { PLANNER_DOCUMENT_SECTIONS } from '../../../core/pipeline-spec/planner-documents.js';
import { EXACT_HEADINGS_INSTRUCTION } from './builder.js';
import { buildLanguageContext } from './language-context.js';
import { assertPlanPromptBound, buildPlanPrompt, buildRegeneratePrompt } from './plan.js';

const spec = { content: 'feature spec', hasClarifications: false };

describe('buildPlanPrompt', () => {
  it('says once, before the first section heading, that the headings are exact', () => {
    const prompt = buildPlanPrompt({ spec, projectContext: 'project' });
    expect(prompt.split(EXACT_HEADINGS_INSTRUCTION)).toHaveLength(2);
    expect(prompt.indexOf(EXACT_HEADINGS_INSTRUCTION)).toBeLessThan(
      prompt.indexOf(`## ${PLANNER_DOCUMENT_SECTIONS.plan[0]}\n`),
    );
  });

  it('TypeScript plan prompt keeps TypeScript examples', () => {
    const prompt = buildPlanPrompt({
      spec,
      projectContext: 'project',
      languageContext: buildLanguageContext('typescript'),
    });
    expect(prompt).toContain('new-file.ts');
    expect(prompt).toContain('TypeScript type annotations');
  });

  it('Python plan prompt has no TypeScript references', () => {
    const prompt = buildPlanPrompt({
      spec,
      projectContext: 'project',
      languageContext: buildLanguageContext('python'),
    });
    expect(prompt).toContain('new-file.py');
    expect(prompt).toContain('Python type hints');
    expect(prompt).toContain('PEP 484');
    expect(prompt).not.toMatch(/TypeScript|typescript|new-file\.ts|modified-file\.ts/);
  });

  it('asks for the touched files grouped by slice under both subsections', () => {
    const prompt = buildPlanPrompt({
      spec,
      projectContext: 'project',
      languageContext: buildLanguageContext('typescript'),
    });
    expect(prompt).toContain('### New Files');
    expect(prompt).toContain('### Modified Files');
    expect(prompt).toContain('group the files of one slice together');
    expect(prompt).not.toContain('provider-chosen pagination');
  });

  it('throws when the prompt exceeds the byte budget', () => {
    expect(() =>
      buildPlanPrompt({ spec, projectContext: 'x'.repeat(500), maxPromptBytes: 100 }),
    ).toThrowError(expect.objectContaining({ kind: 'plan_prompt_too_large' }));
  });

  it('defaults the byte budget to the pipeline spec bound', () => {
    expect(() => assertPlanPromptBound('x'.repeat(PLAN_PROMPT_MAX_BYTES))).not.toThrow();
    expect(() => assertPlanPromptBound('x'.repeat(PLAN_PROMPT_MAX_BYTES + 1))).toThrowError(
      expect.objectContaining({
        data: { actualBytes: PLAN_PROMPT_MAX_BYTES + 1, maxBytes: PLAN_PROMPT_MAX_BYTES },
      }),
    );
  });
});

describe('buildRegeneratePrompt', () => {
  it('gives the skills block its own section, ahead of the document it asks back', () => {
    const skillsContext = '## Active Project Skills\n\n### AuthSkill\nSKILL-BODY';
    const prompt = buildRegeneratePrompt({
      artifactType: 'spec',
      currentContent: '# Spec\n\nDraft.',
      feedback: 'add auth',
      skillsContext,
    });

    expect(prompt).toContain(
      `${skillsContext}\n\n## Current Specification\n# Spec\n\nDraft.\n\n## User Feedback`,
    );
  });
});
