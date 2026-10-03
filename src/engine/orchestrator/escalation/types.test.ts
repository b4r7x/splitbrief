import { describe, expect, it } from 'vitest';
import { boundedHandBack, failedRetry } from './types.js';

describe('failedRetry', () => {
  it('carries no detail keys when none is given', () => {
    expect(failedRetry(3)).toEqual({ completed: false, method: 'failed', attempts: 3 });
  });

  it('carries only the detail fields that are set', () => {
    const result = failedRetry(3, { lastError: 'typecheck failed' });
    expect(result).toEqual({
      completed: false,
      method: 'failed',
      attempts: 3,
      lastError: 'typecheck failed',
    });
    expect('handBack' in result).toBe(false);
  });
});

describe('boundedHandBack', () => {
  it('is absent for no text or whitespace', () => {
    expect(boundedHandBack(undefined)).toBeUndefined();
    expect(boundedHandBack('   \n')).toBeUndefined();
  });

  it('keeps short text trimmed and the tail of long text', () => {
    expect(boundedHandBack('  I could not find the prop.  ')).toBe('I could not find the prop.');
    const long = `${'x'.repeat(5000)}END`;
    const tail = boundedHandBack(long);
    expect(tail?.length).toBe(2000);
    expect(tail).toBe(long.slice(-2000));
  });
});
