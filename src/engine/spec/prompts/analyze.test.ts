import { describe, it, expect } from 'vitest';
import { buildAnalyzePrompt } from './analyze.js';

describe('buildAnalyzePrompt', () => {
  it('embeds spec, plan, and tasks text under labelled sections', () => {
    const prompt = buildAnalyzePrompt('SPEC_BODY', 'PLAN_BODY', 'TASKS_BODY');
    expect(prompt).toMatch(/^##\s+Spec\b/im);
    expect(prompt).toMatch(/^##\s+Plan\b/im);
    expect(prompt).toMatch(/^##\s+Tasks\b/im);
    expect(prompt).toContain('SPEC_BODY');
    expect(prompt).toContain('PLAN_BODY');
    expect(prompt).toContain('TASKS_BODY');
  });

  it('requires strict JSON output with the documented shape', () => {
    const prompt = buildAnalyzePrompt('a', 'b', 'c');
    expect(prompt.toLowerCase()).toContain('strict json');
    expect(prompt).toContain('"specTaskCoverage"');
    expect(prompt).toContain('"planTaskCoverage"');
    expect(prompt).toContain('"orphanTasks"');
    expect(prompt).toContain('"unaddressedSpecSections"');
  });

  it('mentions all four metric names in the instructions', () => {
    const prompt = buildAnalyzePrompt('a', 'b', 'c');
    expect(prompt).toContain('specTaskCoverage');
    expect(prompt).toContain('planTaskCoverage');
    expect(prompt).toContain('orphanTasks');
    expect(prompt).toContain('unaddressedSpecSections');
  });
});
