import { describe, expect, it } from 'vitest';
import { isRecord, narrowRecord } from './type-guards.js';

describe('isRecord', () => {
  it('accepts plain objects', () => {
    expect(isRecord({ key: 'value' })).toBe(true);
  });

  it('rejects arrays', () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord([{ key: 'value' }])).toBe(false);
  });

  it('rejects null and primitives', () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord('value')).toBe(false);
    expect(isRecord(1)).toBe(false);
  });
});

describe('narrowRecord', () => {
  it('returns null for arrays', () => {
    expect(narrowRecord([])).toBeNull();
  });
});
