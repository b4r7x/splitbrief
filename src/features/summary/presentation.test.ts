import { describe, expect, it } from 'vitest';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { PLANNER_INHERITANCE } from '../../core/crew/identity.js';
import { arrowSep } from '../../components/separators.js';
import { formatReviewerSummary, formatRouteSummary } from './presentation.js';

describe('formatReviewerSummary', () => {
  it('names the reviewer when the run had its own reviewer seat', () => {
    const result = formatReviewerSummary(
      makeSummary({ reviewerTool: 'codex', reviewerModel: 'gpt-5-codex' }),
    );
    expect(result).not.toBeNull();
    expect(result).toContain('Codex');
    expect(result).not.toBe(PLANNER_INHERITANCE.sentence);
  });

  it('reports inheritance when the reviewer seat was held by the planner', () => {
    expect(formatReviewerSummary(makeSummary({ plannerTool: 'claude-code' }))).toBe(
      PLANNER_INHERITANCE.sentence,
    );
  });

  it('returns null when neither seat is named', () => {
    expect(formatReviewerSummary(makeSummary({}))).toBeNull();
  });
});

describe('formatRouteSummary', () => {
  it('chains three segments for an own-reviewer run', () => {
    const summary = makeSummary({
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
      reviewerTool: 'codex',
    });
    const route = formatRouteSummary(summary, 'Ollama');
    expect(route).not.toBeNull();
    const parts = route?.split(arrowSep()) ?? [];
    expect(parts).toHaveLength(3);
  });

  it('chains two segments when the reviewer inherited the planner', () => {
    const summary = makeSummary({
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });
    const route = formatRouteSummary(summary, 'Ollama');
    expect(route).not.toBeNull();
    const parts = route?.split(arrowSep()) ?? [];
    expect(parts).toHaveLength(2);
  });

  it('returns null, not an empty string, when the chain is empty', () => {
    expect(formatRouteSummary(makeSummary({}), null)).not.toBe('');
    expect(formatRouteSummary(makeSummary({}), null)).toBeNull();
  });

  it('returns null when both leading segments are absent', () => {
    expect(formatRouteSummary(makeSummary({ reviewerTool: 'codex' }), null)).toBeNull();
  });
});
