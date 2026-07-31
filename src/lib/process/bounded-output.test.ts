import { describe, expect, it } from 'vitest';
import { createBoundedOutput } from './bounded-output.js';

describe('createBoundedOutput', () => {
  it('keeps only a bounded tail while tracking all bytes seen', () => {
    const output = createBoundedOutput({ maxBytes: 32, policy: 'tail' });

    output.append('x'.repeat(40));
    output.append('tail');

    expect(output.snapshot()).toEqual({
      text: '\n[... output truncated ...]\ntail',
      bytesSeen: 44,
      bytesStored: 32,
      omittedBytes: 40,
      truncated: true,
      policy: 'tail',
      maxBytes: 32,
    });
  });

  it('keeps bounded prefix and tail without splitting UTF-8 characters', () => {
    const output = createBoundedOutput({ maxBytes: 40, policy: 'prefix-tail' });

    output.append(`abcdef日本語${'x'.repeat(40)}uvwxyz`);

    const snapshot = output.snapshot();
    expect(snapshot.text).toBe('abcdef\n[... output truncated ...]\nuvwxyz');
    expect(snapshot.bytesSeen).toBe(
      Buffer.byteLength(`abcdef日本語${'x'.repeat(40)}uvwxyz`, 'utf8'),
    );
    expect(snapshot.bytesStored).toBe(40);
    expect(snapshot.omittedBytes).toBe(Buffer.byteLength(`日本語${'x'.repeat(40)}`, 'utf8'));
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.text).not.toContain('�');
  });

  it('supports a zero byte budget', () => {
    const output = createBoundedOutput({ maxBytes: 0 });

    output.append('abc');

    expect(output.snapshot()).toMatchObject({
      text: '',
      bytesSeen: 3,
      bytesStored: 0,
      omittedBytes: 3,
      truncated: true,
    });
  });

  it('retains a UTF-8-safe bounded partial snapshot at a fatal budget boundary', () => {
    const output = createBoundedOutput({ maxBytes: 48, policy: 'prefix-tail' });

    output.append('before-日本語-');
    output.append('event-data-'.repeat(20));
    const snapshot = output.snapshot();

    expect(snapshot).toMatchObject({
      truncated: true,
      maxBytes: 48,
      policy: 'prefix-tail',
    });
    expect(Buffer.byteLength(snapshot.text, 'utf8')).toBeLessThanOrEqual(48);
    expect(snapshot.text).not.toContain('�');
    expect(snapshot.text).toContain('output truncated');
  });
});
