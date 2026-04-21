import { describe, it, expect } from 'vitest';
import { buildInstantPrompt } from './instant.js';

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
});
