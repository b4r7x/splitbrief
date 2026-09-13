import { describe, it, expect } from 'vitest';
import { buildLanguageContext } from './language-context.js';
import { buildSpecPrompt } from './spec.js';

describe('buildSpecPrompt', () => {
  it('carries the active skills section after the research findings', () => {
    const prompt = buildSpecPrompt(
      'feature',
      'findings',
      buildLanguageContext('typescript'),
      '## Active Project Skills\n\n### AuthSkill\nSKILL-BODY',
    );
    expect(prompt).toContain('## Research Findings\nfindings\n\n## Active Project Skills');
    expect(prompt).toContain('SKILL-BODY');
  });

  it('omits the skills section when no skill is attached', () => {
    const prompt = buildSpecPrompt('feature', 'findings');
    expect(prompt).toContain('## Research Findings\nfindings');
    expect(prompt).not.toContain('Active Project Skills');
  });
});
