import { describe, it, expect } from 'vitest';
import { gitError } from './client.js';

describe('gitError', () => {
  it('creates a discriminated AppError for failed commands', () => {
    const err = gitError.commandFailed('rev-parse HEAD', 'not a git repository');
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe('git-command-failed');
    expect(err.message).toContain('rev-parse HEAD');
    expect(err.message).toContain('not a git repository');
    expect(err.data).toEqual({ intent: 'rev-parse HEAD', causeMessage: 'not a git repository' });
  });
});
