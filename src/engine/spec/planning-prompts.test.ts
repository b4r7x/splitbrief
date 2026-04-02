import { describe, it, expect } from 'vitest';
import { buildResearchPrompt, buildSpecPrompt, buildPlanPrompt, buildTasksPrompt, buildRegeneratePrompt } from './planning-prompts.js';

describe('buildResearchPrompt', () => {
  it('contains the feature description', () => {
    const result = buildResearchPrompt('add user auth', 'project context here');
    expect(result).toContain('add user auth');
  });

  it('contains the project context', () => {
    const result = buildResearchPrompt('feature', '## Package: my-app');
    expect(result).toContain('## Package: my-app');
  });

  it('contains output format instructions', () => {
    const result = buildResearchPrompt('feature', 'ctx');
    expect(result).toContain('### Project Overview');
    expect(result).toContain('### Architecture');
    expect(result).toContain('### Relevant Code');
  });

  it('includes skills context when provided', () => {
    const result = buildResearchPrompt('feature', 'ctx', '## Skills\n- skill1');
    expect(result).toContain('## Skills');
    expect(result).toContain('skill1');
  });

  it('omits skills section when not provided', () => {
    const result = buildResearchPrompt('feature', 'ctx');
    expect(result).not.toContain('## Skills');
  });

  it('contains question format instructions', () => {
    const result = buildResearchPrompt('feature', 'ctx');
    expect(result).toContain('<!-- Q:');
    expect(result).toContain('Maximum 5 questions');
  });
});

describe('buildSpecPrompt', () => {
  it('contains feature and research output', () => {
    const result = buildSpecPrompt('add auth', 'research findings here');
    expect(result).toContain('add auth');
    expect(result).toContain('research findings here');
  });

  it('contains required spec sections', () => {
    const result = buildSpecPrompt('feature', 'research');
    expect(result).toContain('### Overview');
    expect(result).toContain('### User Scenarios');
    expect(result).toContain('### Acceptance Criteria');
    expect(result).toContain('### Functional Requirements');
  });

  it('includes clarifications when provided', () => {
    const result = buildSpecPrompt('feature', 'research', [
      { question: 'Use JWT?', answer: 'Yes' },
    ]);
    expect(result).toContain('Use JWT?');
    expect(result).toContain('Yes');
    expect(result).toContain('## User Clarifications');
  });

  it('omits clarifications section when not provided', () => {
    const result = buildSpecPrompt('feature', 'research');
    expect(result).not.toContain('## User Clarifications');
  });
});

describe('buildPlanPrompt', () => {
  it('contains spec and project context', () => {
    const result = buildPlanPrompt('the spec content', 'project ctx');
    expect(result).toContain('the spec content');
    expect(result).toContain('project ctx');
  });

  it('contains required plan sections', () => {
    const result = buildPlanPrompt('spec', 'ctx');
    expect(result).toContain('### Architecture Decisions');
    expect(result).toContain('### File Structure');
    expect(result).toContain('### Dependencies');
    expect(result).toContain('### Testing Strategy');
  });

  it('includes skills context when provided', () => {
    const result = buildPlanPrompt('spec', 'ctx', '## Available Skills');
    expect(result).toContain('## Available Skills');
  });
});

describe('buildTasksPrompt', () => {
  it('contains spec and plan', () => {
    const result = buildTasksPrompt('spec content', 'plan content');
    expect(result).toContain('spec content');
    expect(result).toContain('plan content');
  });

  it('contains task format instructions', () => {
    const result = buildTasksPrompt('spec', 'plan');
    expect(result).toContain('### Description');
    expect(result).toContain('### Signature');
    expect(result).toContain('### Type Definitions');
    expect(result).toContain('### Implementation Steps');
    expect(result).toContain('### Tests');
    expect(result).toContain('### Constraints');
  });

  it('contains critical rules', () => {
    const result = buildTasksPrompt('spec', 'plan');
    expect(result).toContain('Self-contained');
    expect(result).toContain('Atomic');
    expect(result).toContain('Dependency-ordered');
  });
});

describe('buildRegeneratePrompt', () => {
  it('includes current content and feedback for spec', () => {
    const result = buildRegeneratePrompt('spec', 'current spec', 'need more detail');
    expect(result).toContain('Specification');
    expect(result).toContain('current spec');
    expect(result).toContain('need more detail');
  });

  it('includes current content and feedback for plan', () => {
    const result = buildRegeneratePrompt('plan', 'current plan', 'too vague');
    expect(result).toContain('Implementation Plan');
    expect(result).toContain('current plan');
    expect(result).toContain('too vague');
  });
});
