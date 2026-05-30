import { describe, it, expect } from 'vitest';
import { buildAnalyzePrompt } from './analyze.js';

describe('buildAnalyzePrompt', () => {
  it('embeds spec, plan, and tasks text under labelled sections', () => {
    const prompt = buildAnalyzePrompt({
      spec: 'SPEC_BODY',
      plan: 'PLAN_BODY',
      tasks: 'TASKS_BODY',
    });
    expect(prompt).toMatch(/^##\s+Spec\b/im);
    expect(prompt).toMatch(/^##\s+Plan\b/im);
    expect(prompt).toMatch(/^##\s+Tasks\b/im);
    expect(prompt).toContain('SPEC_BODY');
    expect(prompt).toContain('PLAN_BODY');
    expect(prompt).toContain('TASKS_BODY');
  });

  it('requires strict JSON output with the documented shape', () => {
    const prompt = buildAnalyzePrompt({ spec: 'a', plan: 'b', tasks: 'c' });
    expect(prompt.toLowerCase()).toContain('strict json');
    expect(prompt).toContain('"specTaskCoverage"');
    expect(prompt).toContain('"planTaskCoverage"');
    expect(prompt).toContain('"orphanTasks"');
    expect(prompt).toContain('"unaddressedSpecSections"');
  });
});
