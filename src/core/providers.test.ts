import { describe, it, expect } from 'vitest';
import { normalizeConfiguredModel, resolveAutoModel } from './providers.js';

describe('resolveAutoModel', () => {
  it('returns undefined for "auto"', () => {
    expect(resolveAutoModel('auto')).toBeUndefined();
  });

  it('returns undefined when model is undefined', () => {
    expect(resolveAutoModel(undefined)).toBeUndefined();
  });

  it('passes through a real model name', () => {
    expect(resolveAutoModel('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });

  it('resolves empty string to undefined', () => {
    expect(resolveAutoModel('')).toBeUndefined();
  });

  it('resolves whitespace-only string to undefined', () => {
    expect(resolveAutoModel('   ')).toBeUndefined();
  });

  it('is case-insensitive for "Auto"', () => {
    expect(resolveAutoModel('Auto')).toBeUndefined();
  });

  it('is case-insensitive for "AUTO"', () => {
    expect(resolveAutoModel('AUTO')).toBeUndefined();
  });

  it('is case-insensitive for "aUtO"', () => {
    expect(resolveAutoModel('aUtO')).toBeUndefined();
  });

  it('normalizes legacy Claude Code auto to default for picker/config consumers', () => {
    expect(normalizeConfiguredModel('auto', 'claude-code')).toBe('default');
  });

  it('treats Claude Code default as no override at runtime', () => {
    expect(resolveAutoModel('default', 'claude-code')).toBeUndefined();
  });

  it('resolves OpenAI auto to the bundled default model', () => {
    expect(resolveAutoModel('auto', 'openai')).toBe('gpt-5.4');
  });
});

