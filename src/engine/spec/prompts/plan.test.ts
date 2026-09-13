import { describe, it, expect } from 'vitest';
import { PLAN_PROMPT_MAX_BYTES } from '../../../core/pipeline-spec/brief.js';
import { buildLanguageContext } from './language-context.js';
import { assertPlanPromptBound, buildPlanPrompt } from './plan.js';

const spec = { content: 'feature spec', hasClarifications: false };

describe('buildPlanPrompt', () => {
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
