import { describe, it, expect } from 'vitest';
import { buildLanguageContext } from './language-context.js';
import { buildPlanPrompt } from './plan.js';

const spec = { content: 'feature spec', hasClarifications: false };

describe('buildPlanPrompt', () => {
  it('TypeScript plan prompt keeps TypeScript examples', () => {
    const prompt = buildPlanPrompt(spec, 'project', undefined, buildLanguageContext('typescript'));
    expect(prompt).toContain('new-file.ts');
    expect(prompt).toContain('TypeScript type annotations');
  });

  it('Python plan prompt has no TypeScript references', () => {
    const prompt = buildPlanPrompt(spec, 'project', undefined, buildLanguageContext('python'));
    expect(prompt).toContain('new-file.py');
    expect(prompt).toContain('Python type hints');
    expect(prompt).toContain('PEP 484');
    expect(prompt).not.toMatch(/TypeScript|typescript|new-file\.ts|modified-file\.ts/);
  });
});
