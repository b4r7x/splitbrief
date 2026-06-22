import { describe, expect, it } from 'vitest';
import { normalizeKeySignature } from './normalize.js';

describe('normalizeKeySignature', () => {
  it('normalizes Ctrl+A as a stable signature', () => {
    expect(normalizeKeySignature({ input: 'a', key: { ctrl: true } })).toMatchObject({
      key: 'a',
      display: 'Ctrl+A',
      ctrl: true,
      alt: false,
    });
  });

  it('normalizes Alt and Meta activity aliases without changing the base key', () => {
    expect(normalizeKeySignature({ input: 'a', key: { meta: true } })).toMatchObject({
      key: 'a',
      display: 'Alt+A',
      alt: true,
    });
    expect(normalizeKeySignature({ input: 'a', key: { super: true } })).toMatchObject({
      key: 'a',
      display: 'Meta+A',
      super: true,
    });
  });

  it('normalizes navigation and deletion keys independently from raw input bytes', () => {
    expect(normalizeKeySignature({ input: '', key: { shift: true, upArrow: true } })).toMatchObject(
      {
        key: 'arrow-up',
        display: 'Shift+↑',
      },
    );
    expect(normalizeKeySignature({ input: '', key: { ctrl: true, delete: true } })).toMatchObject({
      key: 'delete',
      display: 'Ctrl+Delete',
    });
  });
});
