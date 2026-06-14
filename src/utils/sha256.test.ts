import { describe, it, expect } from 'vitest';
import { sha256Hex } from './sha256.js';

describe('sha256Hex', () => {
  it('returns the known digest for the empty string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('returns the known digest for "abc"', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes a string and its utf8 Buffer to the same digest', () => {
    const text = 'héllo wörld';
    expect(sha256Hex(text)).toBe(sha256Hex(Buffer.from(text, 'utf8')));
  });
});
