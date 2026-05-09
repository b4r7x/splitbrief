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
  it('uses structured summaries for api planners in auto mode', () => {
    expect(resolveCompactionFormat('auto', 'api')).toBe('structured');
  });

  it('uses structured summaries for agent-sdk planners in auto mode', () => {
    expect(resolveCompactionFormat('auto', 'agent-sdk')).toBe('structured');
  });

  it('uses freeform summaries for cli planners in auto mode', () => {
    expect(resolveCompactionFormat('auto', 'cli')).toBe('freeform');
  });

  it('keeps explicit freeform mode regardless of planner kind', () => {
    expect(resolveCompactionFormat('freeform', 'api')).toBe('freeform');
  });

  it('keeps explicit structured mode regardless of planner kind', () => {
    expect(resolveCompactionFormat('structured', 'cli')).toBe('structured');
  });
});

describe('tryParseStructuredSummary', () => {
  it('parses valid JSON summaries', () => {
    expect(tryParseStructuredSummary(JSON.stringify(structuredSummary))).toEqual(structuredSummary);
  });

  it('returns null for invalid JSON', () => {
    expect(tryParseStructuredSummary('not json')).toBeNull();
  });

  it('returns null for JSON missing fields', () => {
    expect(tryParseStructuredSummary('{"goal":"x"}')).toBeNull();
  });
});
