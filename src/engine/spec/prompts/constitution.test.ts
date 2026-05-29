import { describe, it, expect } from 'vitest';
import { buildConstitutionPrompt } from './constitution.js';

describe('buildConstitutionPrompt', () => {
  it('embeds the constitution, feature, and spec content', () => {
    const prompt = buildConstitutionPrompt({
      feature: 'add login',
      spec: '# Spec body',
      constitutionContent: '# Constitution\nNo classes.',
    });
    expect(prompt).toContain('add login');
    expect(prompt).toContain('# Spec body');
    expect(prompt).toContain('No classes.');
  });

  it('falls back to a placeholder when the constitution is empty', () => {
    const prompt = buildConstitutionPrompt({
      feature: 'feat',
      spec: 'spec',
      constitutionContent: '',
    });
    expect(prompt).toMatch(/no constitution\.md present/i);
  });

  it('falls back to a placeholder when the spec is empty', () => {
    const prompt = buildConstitutionPrompt({
      feature: 'feat',
      spec: '',
      constitutionContent: '# Constitution',
    });
    expect(prompt).toMatch(/spec not yet written/i);
  });

  it('requests strict JSON output with passed/violations shape', () => {
    const prompt = buildConstitutionPrompt({ feature: 'f', spec: 's', constitutionContent: 'c' });
    expect(prompt.toLowerCase()).toContain('strict json');
    expect(prompt).toContain('"passed"');
    expect(prompt).toContain('"violations"');
    expect(prompt).toContain('"severity"');
  });
});
