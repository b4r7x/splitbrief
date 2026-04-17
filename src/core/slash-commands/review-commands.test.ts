import { describe, it, expect } from 'vitest';
import { parseReviewCommand } from './review-commands.js';

describe('parseReviewCommand', () => {
  it.each(['approve', 'yes', 'y', 'ok', 'lgtm', 'continue'])
    ('recognizes approve alias: %s', (input) => {
      expect(parseReviewCommand(input)).toEqual({ action: 'approve' });
    });

  it.each(['quit', 'reject', 'no', 'n'])
    ('recognizes quit alias: %s', (input) => {
      expect(parseReviewCommand(input)).toEqual({ action: 'quit' });
    });

  it('recognizes edit', () => {
    expect(parseReviewCommand('edit')).toEqual({ action: 'edit' });
  });

  it('parses comment with text', () => {
    expect(parseReviewCommand('comment fix the typo')).toEqual({
      action: 'approve',
      comment: 'fix the typo',
    });
  });

  it('returns null for unknown input', () => {
    expect(parseReviewCommand('foobar')).toBeNull();
  });

  it('is case insensitive', () => {
    expect(parseReviewCommand('APPROVE')).toEqual({ action: 'approve' });
    expect(parseReviewCommand('Quit')).toEqual({ action: 'quit' });
    expect(parseReviewCommand('EDIT')).toEqual({ action: 'edit' });
  });

  it('trims whitespace', () => {
    expect(parseReviewCommand('  approve  ')).toEqual({ action: 'approve' });
  });

  it('preserves original case in comment text', () => {
    expect(parseReviewCommand('comment Please Fix This')).toEqual({
      action: 'approve',
      comment: 'Please Fix This',
    });
  });

  it('handles leading whitespace in comment command', () => {
    expect(parseReviewCommand('  comment Keep original')).toEqual({
      action: 'approve',
      comment: 'Keep original',
    });
  });

  it('handles leading whitespace with uppercase COMMENT', () => {
    expect(parseReviewCommand('  COMMENT Preserve Case')).toEqual({
      action: 'approve',
      comment: 'Preserve Case',
    });
  });
});
