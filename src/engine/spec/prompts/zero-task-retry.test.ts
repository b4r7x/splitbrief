import { describe, expect, it } from 'vitest';
import { zeroTaskRetryPrompt } from './zero-task-retry.js';

describe('zeroTaskRetryPrompt', () => {
  it('leads with the parse failure and restates the original request', () => {
    const prompt = zeroTaskRetryPrompt('build feature X', []);
    expect(prompt).toContain('Your previous reply could not be used');
    expect(prompt).toContain('The original request follows.');
    expect(prompt).toContain('build feature X');
  });

  it('includes parse diagnostics as bullet lines when provided', () => {
    const prompt = zeroTaskRetryPrompt('build feature X', [
      'no frontmatter found',
      'tasks.md was fenced',
    ]);
    expect(prompt).toContain('- no frontmatter found');
    expect(prompt).toContain('- tasks.md was fenced');
  });
});
