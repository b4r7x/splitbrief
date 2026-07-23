import { describe, expect, it } from 'vitest';
import { resolveCompactionFormat, tryParseStructuredSummary } from './compaction.js';

const structuredSummary = {
  goal: 'add JWT auth',
  stepsCompleted: ['research', 'spec written'],
  currentStep: 'implementing task T003',
  filesModified: ['src/auth/middleware.ts'],
  constraintsDiscovered: ['must use RS256'],
  remainingWork: ['T004', 'T005'],
};

describe('resolveCompactionFormat', () => {
  it.each([
    {
      description: 'uses structured summaries for api planners in auto mode',
      input: { configured: 'auto' as const, plannerKind: 'api' as const },
      expected: 'structured' as const,
    },
    {
      description: 'uses structured summaries for agent-sdk planners in auto mode',
      input: { configured: 'auto' as const, plannerKind: 'agent-sdk' as const },
      expected: 'structured' as const,
    },
    {
      description: 'uses freeform summaries for cli planners in auto mode',
      input: { configured: 'auto' as const, plannerKind: 'cli' as const },
      expected: 'freeform' as const,
    },
    {
      description: 'keeps explicit freeform mode regardless of planner kind',
      input: { configured: 'freeform' as const, plannerKind: 'api' as const },
      expected: 'freeform' as const,
    },
    {
      description: 'keeps explicit structured mode regardless of planner kind',
      input: { configured: 'structured' as const, plannerKind: 'cli' as const },
      expected: 'structured' as const,
    },
  ])('$description', ({ input, expected }) => {
    expect(resolveCompactionFormat(input.configured, input.plannerKind)).toBe(expected);
  });
});

describe('tryParseStructuredSummary', () => {
  it.each([
    {
      description: 'parses valid JSON summaries',
      input: JSON.stringify(structuredSummary),
      expected: structuredSummary,
    },
    {
      description: 'returns null for invalid JSON',
      input: 'not json',
      expected: null,
    },
    {
      description: 'returns null for JSON missing fields',
      input: '{"goal":"x"}',
      expected: null,
    },
  ])('$description', ({ input, expected }) => {
    expect(tryParseStructuredSummary(input)).toEqual(expected);
  });
});
