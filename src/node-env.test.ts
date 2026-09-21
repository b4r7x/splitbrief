import { afterEach, describe, expect, it } from 'vitest';

const original = process.env.NODE_ENV;

afterEach(() => {
  if (original === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = original;
});

describe('node-env', () => {
  it('runs React in production mode', async () => {
    await import('./node-env.js');
    expect(process.env.NODE_ENV).toBe('production');
  });
});
