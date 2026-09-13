import { describe, expect, it } from 'vitest';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { PLANNER_INHERITANCE } from '../../core/crew/identity.js';
import { arrowSep } from '../../components/separators.js';
import { terminalTheme } from '../../components/theme.js';
import {
  formatReviewerSummary,
  formatRouteSummary,
  getSummaryHeading,
  summarizeOutcome,
} from './presentation.js';

describe('getSummaryHeading', () => {
  it('reads a cancelled session as cancelled, not failed', () => {
    expect(getSummaryHeading('cancelled', terminalTheme, true)).toEqual({
      word: 'cancelled',
      color: terminalTheme.warning,
      glyph: 'statusCancelled',
    });
  });

  it('a completed run with findings open is not a green tick', () => {
    expect(getSummaryHeading('complete', terminalTheme, false)).toEqual({
      word: 'complete',
      color: terminalTheme.warning,
      glyph: 'statusWarning',
    });
    expect(getSummaryHeading('complete', terminalTheme, true)).toEqual({
      word: 'complete',
      color: terminalTheme.success,
      glyph: 'check',
    });
  });
});

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

describe('summarizeOutcome', () => {
  const packet = {
    jsonPath: 'evidence/review.json',
    markdownPath: 'evidence/review.md',
    generatedAt: '2026-01-01T00:00:00.000Z',
    finalReviewStatus: 'written' as const,
    finalReviewVerdict: 'pass' as const,
    finalReviewFindingCounts: { critical: 0, warning: 1, note: 0 },
    driftPassed: true,
    evidenceValidatedTasks: 1,
    evidenceTotalTasks: 1,
    missingArtifactCount: 0,
  };

  it('counts one changed file as a file, not files', () => {
    const outcome = summarizeOutcome(makeSummary({ changedFiles: ['src/one.ts'] }), 'complete');

    expect(outcome.facts).toContain('1 file changed');
  });

  it('names the packet to read instead of a key the screen does not answer', () => {
    const clean = summarizeOutcome(
      makeSummary({ reviewPacket: packet, driftSummary: undefined }),
      'complete',
    );
    expect(clean.next).toBe('');

    const blocking = summarizeOutcome(
      makeSummary({
        reviewPacket: packet,
        review: { verdict: 'fail', critical: 2, warnings: 1, notes: 0 },
      }),
      'complete',
    );
    expect(blocking.next).toBe('2 blocking findings in evidence/review.md');
  });

  it('breaks the short-terminal line in two only when it does not fit', () => {
    const summary = makeSummary({ changedFiles: ['src/one.ts', 'src/two.ts'] });

    const narrow = summarizeOutcome(summary, 'complete', { compact: true, width: 76 });
    expect(narrow.facts).toHaveLength(2);
    expect(narrow.facts[1]).toContain('Scope check');
    expect(narrow.facts[1]).toContain('2 files changed');

    const wide = summarizeOutcome(summary, 'complete', { compact: true, width: 156 });
    expect(wide.facts).toHaveLength(1);
    expect(wide.facts[0]).toContain('Scope check');
    expect(wide.facts[0]).toContain('2 files changed');
  });
});
