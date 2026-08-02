import { describe, expect, it } from 'vitest';
import { isAutomaticModel, normalizeConfiguredModel, resolveCliModel } from './automatic-model.js';

describe('normalizeConfiguredModel', () => {
  it.each([
    ['auto', 'auto'],
    ['AUTO', 'auto'],
    ['  auto  ', 'auto'],
    ['aUtO', 'auto'],
  ])('canonicalizes %j to the automatic sentinel', (input, expected) => {
    expect(normalizeConfiguredModel(input)).toBe(expected);
  });

  it.each([
    ['', undefined],
    ['   ', undefined],
    [undefined, undefined],
  ])('treats %j as no model', (input, expected) => {
    expect(normalizeConfiguredModel(input)).toBe(expected);
  });

  it.each([
    ['default', 'default'],
    ['  gpt-5.4  ', 'gpt-5.4'],
    ['Claude-Sonnet-4-6', 'Claude-Sonnet-4-6'],
  ])('keeps %j verbatim apart from trimming', (input, expected) => {
    expect(normalizeConfiguredModel(input)).toBe(expected);
  });
});

describe('legacy Claude Code "default" alias', () => {
  it.each([
    'default',
    'DEFAULT',
    '  default  ',
  ])('treats %j as automatic selection for claude-code only', (input) => {
    expect(normalizeConfiguredModel(input, 'claude-code')).toBe('auto');
    expect(isAutomaticModel(input, 'claude-code')).toBe(true);
    expect(resolveCliModel(input, 'claude-code')).toBeUndefined();
  });

  it('keeps "default" a literal model id for every other tool', () => {
    expect(normalizeConfiguredModel('default', 'codex')).toBe('default');
    expect(normalizeConfiguredModel('default')).toBe('default');
    expect(isAutomaticModel('default', 'codex')).toBe(false);
    expect(resolveCliModel('default', 'codex')).toBe('default');
  });
});

describe('isAutomaticModel', () => {
  it.each([
    ['auto', true],
    ['AUTO', true],
    ['  auto ', true],
    ['gpt-5.4', false],
    ['', false],
    ['   ', false],
    [undefined, false],
  ])('reports %j as %j', (input, expected) => {
    expect(isAutomaticModel(input)).toBe(expected);
  });
});

describe('resolveCliModel', () => {
  it.each([
    'auto',
    'AUTO',
    '  auto  ',
    undefined,
    '',
    '   ',
  ])('resolves %j to no model so the adapter omits --model', (input) => {
    expect(resolveCliModel(input)).toBeUndefined();
  });

  it('passes an explicit model id through', () => {
    expect(resolveCliModel('gpt-5.4')).toBe('gpt-5.4');
    expect(resolveCliModel('  gpt-5-codex ')).toBe('gpt-5-codex');
  });
});
