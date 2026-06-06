import { describe, it, expect } from 'vitest';
import { normalizeConfiguredModel, resolveAutoModel } from './model-selection.js';

describe('resolveAutoModel', () => {
  it.each([
    ['auto', undefined, undefined],
    [undefined, undefined, undefined],
    ['', undefined, undefined],
    ['   ', undefined, undefined],
    ['Auto', undefined, undefined],
    ['AUTO', undefined, undefined],
    ['aUtO', undefined, undefined],
    ['default', 'claude-code', undefined],
  ])('resolves %j (tool=%j) to undefined', (model, tool, _expected) => {
    expect(resolveAutoModel(model, tool as string | undefined)).toBeUndefined();
  });

  it.each([
    ['claude-sonnet-4-6', undefined, 'claude-sonnet-4-6'],
    ['auto', 'openai', 'gpt-5.4'],
  ])('resolves %j (tool=%j) to %j', (model, tool, expected) => {
    expect(resolveAutoModel(model, tool as string | undefined)).toBe(expected);
  });

  it('canonicalizes auto to lower-case for picker/config consumers', () => {
    expect(normalizeConfiguredModel('AUTO', 'claude-code')).toBe('auto');
  });

  it('normalizes legacy Claude Code default to auto for picker/config consumers', () => {
    expect(normalizeConfiguredModel('default', 'claude-code')).toBe('auto');
  });
});
