import { describe, it, expect } from 'vitest';
import { buildFinalReviewPrompt } from './review-prompts.js';

describe('buildFinalReviewPrompt', () => {
  it('contains the spec content', () => {
    const result = buildFinalReviewPrompt('## Acceptance Criteria\n1. Must handle auth', '+added line');
    expect(result).toContain('## Acceptance Criteria');
    expect(result).toContain('Must handle auth');
  });

  it('contains the diff', () => {
    const diff = '+export function login() {}\n-export function old() {}';
    const result = buildFinalReviewPrompt('spec', diff);
    expect(result).toContain('+export function login() {}');
    expect(result).toContain('-export function old() {}');
  });

  it('wraps diff in a code fence', () => {
    const result = buildFinalReviewPrompt('spec', 'diff content');
    expect(result).toContain('```diff');
  });

  it('contains review checklist items', () => {
    const result = buildFinalReviewPrompt('spec', 'diff');
    expect(result).toContain('Acceptance Criteria');
    expect(result).toContain('Functional Requirements');
    expect(result).toContain('Error Handling');
    expect(result).toContain('Edge Cases');
    expect(result).toContain('Type Safety');
    expect(result).toContain('Code Quality');
  });

  it('contains verdict output format', () => {
    const result = buildFinalReviewPrompt('spec', 'diff');
    expect(result).toContain('### Verdict');
    expect(result).toContain('`pass`');
    expect(result).toContain('`pass_with_notes`');
    expect(result).toContain('`fail`');
  });

  it('contains findings categories', () => {
    const result = buildFinalReviewPrompt('spec', 'diff');
    expect(result).toContain('**Critical**');
    expect(result).toContain('**Warning**');
    expect(result).toContain('**Note**');
  });
});
