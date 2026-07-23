import { describe, test, expect } from 'vitest';
import { fsError } from './fs.js';

describe('fsError factories', () => {
  test.each([
    {
      label: 'session-id',
      id: 'bad/value',
      reason: undefined,
      message: "Invalid session-id 'bad/value'",
    },
    {
      label: 'filename',
      id: '../traversal',
      reason: "must not contain '..', '/' or '\\'",
      message: "Invalid filename '../traversal': must not contain '..', '/' or '\\'",
    },
  ])('invalidId formats $label failures', ({ label, id, reason, message }) => {
    const err = fsError.invalidId(label, id, reason);

    expect(err).toMatchObject({
      kind: 'fs-invalid-id',
      message,
      data: { label, id, reason },
    });
  });
});

describe('fsError.isInvalidId predicate', () => {
  test('matches invalidId output', () => {
    expect(fsError.isInvalidId(fsError.invalidId('x', 'y'))).toBe(true);
    expect(fsError.isInvalidId(fsError.invalidId('x', 'y', 'reason'))).toBe(true);
  });

  test('rejects non-matching values', () => {
    expect(fsError.isInvalidId(new Error('plain'))).toBe(false);
    expect(fsError.isInvalidId(null)).toBe(false);
    expect(fsError.isInvalidId({ kind: 'fs-invalid-id' })).toBe(false);
  });
});
