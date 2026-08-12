import { describe, it, expect } from 'vitest';
import {
  REVIEW_HINT,
  REVIEW_UNKNOWN_COMMAND_MESSAGE,
  parseReviewCommand,
  reviewOpeningPromptMessage,
} from './review-commands.js';
import { fitKeyLegend } from './input-hints.js';

describe('REVIEW_HINT', () => {
  // Asserted against the literal legend rather than against the constant it names, so the
  // assertion still fails if the legend changes wording, order, or separator.
  it('names four keys once each, in one order, for every review phase', () => {
    expect(REVIEW_HINT).toBe('y approve · c comment · q reject · e edit');
    expect(reviewOpeningPromptMessage()).toBe(
      'Review prompt is opening. Once active, use: y approve · c comment · q reject · e edit',
    );
  });

  it('fits the review legend on one 78-column row and drops nothing above 40', () => {
    expect(REVIEW_HINT.length).toBeLessThanOrEqual(78);
    expect(fitKeyLegend(REVIEW_HINT, 78)).toBe(REVIEW_HINT);
    // At 40 columns the fourth token does not fit; it is dropped whole rather than ellipsised,
    // and `e` stays reachable through ctrl+e and the composer placeholder.
    expect(fitKeyLegend(REVIEW_HINT, 40)).toBe('y approve · c comment · q reject');
    expect(fitKeyLegend(REVIEW_HINT, 40)).not.toContain('…');
  });

  it('offers only commands the parser accepts when it rejects one', () => {
    for (const command of ['approve', 'reject', 'edit']) {
      expect(REVIEW_UNKNOWN_COMMAND_MESSAGE).toContain(command);
      expect(parseReviewCommand(command)).not.toBeNull();
    }
    expect(parseReviewCommand('comment add more tests')).not.toBeNull();
  });

  it('never offers the readiness override, which only the review header can honour', () => {
    expect(REVIEW_HINT).not.toContain('approve again overrides');
    expect(reviewOpeningPromptMessage()).not.toContain('approve again overrides');
  });
});

describe('parseReviewCommand', () => {
  it('parses approve', () => {
    expect(parseReviewCommand('approve')).toEqual({
      kind: 'brief-review-command',
      command: { action: 'approve' },
    });
    expect(parseReviewCommand('yes')).toEqual({
      kind: 'brief-review-command',
      command: { action: 'approve' },
    });
  });

  it('parses reject/quit aliases', () => {
    expect(parseReviewCommand('reject')).toEqual({
      kind: 'brief-review-command',
      command: { action: 'reject' },
    });
    expect(parseReviewCommand('quit')).toEqual({
      kind: 'brief-review-command',
      command: { action: 'reject' },
    });
    expect(parseReviewCommand('q')).toEqual({
      kind: 'brief-review-command',
      command: { action: 'reject' },
    });
  });

  it('parses comment with text', () => {
    expect(parseReviewCommand('comment add more tests')).toEqual({
      kind: 'brief-review-command',
      command: { action: 'revise', comment: 'add more tests' },
    });
    expect(parseReviewCommand('revise split the first task')).toEqual({
      kind: 'brief-review-command',
      command: { action: 'revise', comment: 'split the first task' },
    });
  });

  it('parses edit', () => {
    expect(parseReviewCommand('edit')).toEqual({ kind: 'open-external-editor' });
    expect(parseReviewCommand('e')).toEqual({ kind: 'open-external-editor' });
  });

  it('parses explicit external edit commands', () => {
    expect(parseReviewCommand('E')).toEqual({ kind: 'open-external-editor' });
    expect(parseReviewCommand('edit-file')).toEqual({ kind: 'open-external-editor' });
    expect(parseReviewCommand('external_edit_applied')).toEqual({
      kind: 'brief-review-command',
      command: { action: 'external_edit_applied' },
    });
  });

  it('parses non-settling brief review commands', () => {
    expect(parseReviewCommand('save_draft')).toEqual({
      kind: 'brief-review-command',
      command: { action: 'save_draft' },
    });
    expect(parseReviewCommand('status')).toEqual({
      kind: 'brief-review-command',
      command: { action: 'status' },
    });
  });

  it('returns null for unknown input', () => {
    expect(parseReviewCommand('unknown command here')).toBeNull();
  });
});
