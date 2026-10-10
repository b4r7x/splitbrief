import { describe, expect, it } from 'vitest';
import { deepFreeze } from './deep-freeze.js';

describe('deepFreeze', () => {
  it('freezes nested objects and arrays and returns the same reference', () => {
    const value = { items: [{ limit: { context: 128_000 }, tags: ['text'] }], empty: null };

    expect(deepFreeze(value)).toBe(value);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.items)).toBe(true);
    expect(Object.isFrozen(value.items[0])).toBe(true);
    expect(Object.isFrozen(value.items[0]?.limit)).toBe(true);
    expect(Object.isFrozen(value.items[0]?.tags)).toBe(true);
    expect(() => value.items.push({ limit: { context: 1 }, tags: [] })).toThrow(TypeError);
    expect(() => value.items[0]?.tags.push('image')).toThrow(TypeError);
    expect(deepFreeze(value)).toBe(value);
  });

  it('returns primitives and null unchanged', () => {
    expect(deepFreeze(null)).toBeNull();
    expect(deepFreeze(undefined)).toBeUndefined();
    expect(deepFreeze(1)).toBe(1);
    expect(deepFreeze('text')).toBe('text');
  });

  it('freezes descendants of a shallow-frozen object', () => {
    const nested = { context: 128_000 };
    const value = Object.freeze({ nested });
    expect(deepFreeze(value)).toBe(value);
    expect(() => {
      nested.context = 1;
    }).toThrow(TypeError);
  });
});
