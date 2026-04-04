import { describe, it, expect, beforeEach } from 'vitest';
import { errorStore } from './error.js';

describe('errorStore', () => {
  beforeEach(() => errorStore.reset());

  it('starts with null message', () => {
    expect(errorStore.get().message).toBeNull();
  });

  it('sets error message', () => {
    errorStore.setError('something broke');
    expect(errorStore.get().message).toBe('something broke');
  });

  it('clears error with setError(null)', () => {
    errorStore.setError('oops');
    errorStore.setError(null);
    expect(errorStore.get().message).toBeNull();
  });
});
