import { describe, expect, it } from 'vitest';
import { PLANNER_DOCUMENT_SECTIONS } from '../../../core/pipeline-spec/planner-documents.js';
import { EXACT_HEADINGS_INSTRUCTION } from './builder.js';
import { buildResearchPrompt } from './research.js';

describe('buildResearchPrompt', () => {
  it('says once, before the first section heading, that the headings are exact', () => {
    const prompt = buildResearchPrompt('feature', 'project');
    expect(prompt.split(EXACT_HEADINGS_INSTRUCTION)).toHaveLength(2);
    expect(prompt.indexOf(EXACT_HEADINGS_INSTRUCTION)).toBeLessThan(
      prompt.indexOf(`### ${PLANNER_DOCUMENT_SECTIONS.research[0]}`),
    );
  });
});
