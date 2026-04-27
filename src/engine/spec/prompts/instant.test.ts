import { describe, it, expect } from 'vitest';
import { buildInstantPrompt } from './instant.js';
import { buildQuickPlanPrompt } from './quick-plan.js';

describe('buildInstantPrompt', () => {
  it('requests only a Tasks section (no Spec / no Plan)', () => {
    const prompt = buildInstantPrompt('rename foo to bar', 'repo-map: small');
    expect(prompt).toMatch(/tasks/i);
    expect(prompt).not.toMatch(/^##\s+Spec\b/im);
    expect(prompt).not.toMatch(/^##\s+Plan\b/im);
  });

  it('mentions trivial / small model constraint', () => {
    const prompt = buildInstantPrompt('x', 'y');
    expect(prompt.toLowerCase()).toContain('small');
  });

  it('includes skills when provided', () => {
    const prompt = buildInstantPrompt('x', 'y', 'skill: foo');
    expect(prompt).toMatch(/skill: foo/);
    expect(prompt).toMatch(/^##\s+Skills/im);
  });

  it('omits skills section when not provided', () => {
    const prompt = buildInstantPrompt('x', 'y');
    expect(prompt).not.toMatch(/^##\s+Skills/im);
  });

  it('requires Task Brief v1 scope, escalation, and evidence sections', () => {
    const prompt = buildInstantPrompt('x', 'y');
    expect(prompt).toContain('Scope, Implementation Steps, Tests (Validation), Constraints, Escalation, Evidence');
    expect(prompt).toContain('do not omit them');
    expect(prompt).not.toContain('optional in instant mode');
  });
});

describe('buildQuickPlanPrompt', () => {
  it('does not weaken Task Brief v1 scope, escalation, or evidence sections', () => {
    const prompt = buildQuickPlanPrompt('change feature', 'repo');
    expect(prompt).toContain('Scope, Implementation Steps, Tests (Validation), Constraints, Escalation, Evidence');
    expect(prompt).toContain('must include');
    expect(prompt).toContain('must state when the implementer should stop');
    expect(prompt).toContain('must state the reviewable proof');
    expect(prompt).not.toContain('whenever the change touches');
    expect(prompt).not.toContain('when the brief should leave behind');
  });
});
