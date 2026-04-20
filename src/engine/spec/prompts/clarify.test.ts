import { describe, it, expect } from 'vitest';
import { buildClarifyPrompt, DEFAULT_MAX_CLARIFY_QUESTIONS } from './clarify.js';

describe('buildClarifyPrompt', () => {
  it('embeds the spec body verbatim', () => {
    const prompt = buildClarifyPrompt('# My Spec\n- requirement A');
    expect(prompt).toContain('# My Spec');
    expect(prompt).toContain('requirement A');
  });

  it('uses the default max-questions when not provided', () => {
    const prompt = buildClarifyPrompt('s');
    expect(prompt).toContain(`up to ${DEFAULT_MAX_CLARIFY_QUESTIONS}`);
  });

  it('honors a custom max-questions value', () => {
    const prompt = buildClarifyPrompt('s', 2);
    expect(prompt).toContain('up to 2');
  });

  it('instructs the planner to use the inline Q-marker format', () => {
    const prompt = buildClarifyPrompt('s');
    expect(prompt).toContain('<!-- Q:{"id":"Q1","question":"..."} -->');
    expect(prompt).toMatch(/no clarifications needed/i);
  });
});
