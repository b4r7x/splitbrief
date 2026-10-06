import { describe, it, expect } from 'vitest';
import {
  REVIEW_HINT,
  REVIEW_UNKNOWN_COMMAND_MESSAGE,
  parseReviewCommand,
  reviewOpeningPromptMessage,
} from './review-commands.js';
import { fitKeyLegend } from '../../core/key-legend.js';

describe('REVIEW_HINT', () => {
  // Asserted against the literal legend rather than against the constant it names, so the
  // assertion still fails if the legend changes wording, order, or separator.
  it('names the four typed commands once each, with no letter key the card does not take', () => {
    expect(REVIEW_HINT).toBe('approve · comment <text> · end-run · edit');
    expect(reviewOpeningPromptMessage()).toBe(
      'Review prompt is opening. Once active, use: approve · comment <text> · end-run · edit',
    );
  });

  it('fits the review legend on one 78-column row and drops nothing above 34', () => {
    expect(REVIEW_HINT.length).toBeLessThanOrEqual(78);
    expect(fitKeyLegend(REVIEW_HINT, 78)).toBe(REVIEW_HINT);
    // At 34 columns the fourth token does not fit; it is dropped whole rather than ellipsised,
    // and edit stays reachable through ctrl+e and the composer placeholder.
    expect(fitKeyLegend(REVIEW_HINT, 34)).toBe('approve · comment <text> · end-run');
    expect(fitKeyLegend(REVIEW_HINT, 34)).not.toContain('…');
  });

  it('offers only commands the parser accepts when it rejects one', () => {
    for (const command of ['approve', 'end-run', 'edit']) {
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
  it.each([
    ['approve', { kind: 'brief-review-command', command: { action: 'approve' } }],
    ['yes', { kind: 'brief-review-command', command: { action: 'approve' } }],
    ['end-run', { kind: 'brief-review-command', command: { action: 'end-run' } }],
    ['reject', { kind: 'brief-review-command', command: { action: 'end-run' } }],
    ['quit', { kind: 'brief-review-command', command: { action: 'end-run' } }],
    ['q', { kind: 'brief-review-command', command: { action: 'end-run' } }],
    [
      'comment explain the failure',
      {
        kind: 'brief-review-command',
        command: { action: 'revise', comment: 'explain the failure' },
      },
    ],
    [
      'comment add more tests',
      { kind: 'brief-review-command', command: { action: 'revise', comment: 'add more tests' } },
    ],
    [
      'revise split the first task',
      {
        kind: 'brief-review-command',
        command: { action: 'revise', comment: 'split the first task' },
      },
    ],
    ['edit', { kind: 'open-editor' }],
    ['e', { kind: 'open-editor' }],
    ['E', { kind: 'open-editor' }],
    ['edit-file', { kind: 'open-editor' }],
    [
      'external_edit_applied',
      { kind: 'brief-review-command', command: { action: 'external_edit_applied' } },
    ],
    ['save_draft', { kind: 'brief-review-command', command: { action: 'save_draft' } }],
    ['status', { kind: 'brief-review-command', command: { action: 'status' } }],
  ] as const)('keeps the typed review routes canonical: %s', (text, expected) => {
    expect(parseReviewCommand(text)).toEqual(expected);
  });

  it('returns null for unknown input', () => {
    expect(parseReviewCommand('unknown command here')).toBeNull();
  });

  it('refuses override, duplicate, and incomplete intents instead of inventing an action', () => {
    expect(parseReviewCommand('approve again overrides')).toBeNull();
    expect(parseReviewCommand('retry retry')).toBeNull();
    expect(parseReviewCommand('revise')).toBeNull();
  });

  it('opens the comment draft for a bare comment, the word the comment row stands for', () => {
    expect(parseReviewCommand('comment')).toEqual({ kind: 'comment-draft' });
    expect(parseReviewCommand('C')).toEqual({ kind: 'comment-draft' });
  });
});
