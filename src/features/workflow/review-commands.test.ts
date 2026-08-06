import { describe, it, expect } from 'vitest';
import {
  BRIEFS_REVIEW_HINT,
  REVIEW_HINT,
  parseReviewCommand,
  reviewHintForPhase,
  reviewOpeningPromptMessage,
} from './review-commands.js';

describe('reviewHintForPhase', () => {
  it('names the edit-file command only in the briefs phase', () => {
    expect(reviewHintForPhase('reviewing-briefs')).toBe(BRIEFS_REVIEW_HINT);
    expect(reviewHintForPhase('reviewing-spec')).toBe(REVIEW_HINT);
    expect(reviewHintForPhase('reviewing-plan')).toBe(REVIEW_HINT);
  });

  it('never offers the readiness override, which only the review header can honour', () => {
    expect(reviewHintForPhase('reviewing-briefs')).not.toContain('approve again overrides');
    expect(reviewOpeningPromptMessage('reviewing-briefs')).not.toContain('approve again overrides');
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
