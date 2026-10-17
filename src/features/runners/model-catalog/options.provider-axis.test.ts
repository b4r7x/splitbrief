import { describe, expect, it } from 'vitest';
import { assemblePickerDescriptors, buildPickerOptions } from './options.js';
import { compactProviderTag, modelBareId, modelProviderPrefix } from './provider-axis.js';
import { modelProviderAuthKey } from '../../../core/runners/route-auth.js';

describe('providerDependent flag', () => {
  it('marks only the CLIs whose credential oracle serves per-provider facts', () => {
    const items = buildPickerOptions(
      'planner',
      assemblePickerDescriptors(),
      { cliTools: [], providers: [], hasApiKeyOverride: () => false },
      undefined,
    );
    const flagged = items.filter((item) => item.providerDependent === true).map((item) => item.id);

    expect(flagged.toSorted()).toEqual(['kilo-code', 'opencode']);
  });
});

describe('model id provider resolution', () => {
  it('splits auth key (first segment) from display prefix (all but the final segment)', () => {
    expect(modelProviderAuthKey('kilo/openrouter/free')).toBe('kilo');
    expect(modelProviderPrefix('kilo/openrouter/free')).toBe('kilo/openrouter');
    expect(modelProviderAuthKey('github-copilot/gpt-5.6')).toBe('github-copilot');
    expect(modelProviderPrefix('github-copilot/gpt-5.6')).toBe('github-copilot');
  });

  it('yields no provider for unprefixed ids like auto', () => {
    expect(modelProviderAuthKey('auto')).toBeUndefined();
    expect(modelProviderPrefix('auto')).toBeUndefined();
    expect(modelProviderAuthKey('starcoder2:7b')).toBeUndefined();
  });

  it('compacts the display tag to the last prefix segment', () => {
    expect(compactProviderTag('kilo/openrouter')).toBe('openrouter');
    expect(compactProviderTag('github-copilot')).toBe('copilot');
    expect(compactProviderTag('opencode-go')).toBe('opencode-go');
  });

  it('keys merge groups on the final path segment across kilo and opencode shapes', () => {
    expect(modelBareId('kilo/openrouter/deepseek-v4-flash')).toBe('deepseek-v4-flash');
    expect(modelBareId('openrouter/deepseek-v4-flash')).toBe('deepseek-v4-flash');
    expect(modelBareId('deepseek-v4-flash')).toBe('deepseek-v4-flash');
    expect(modelBareId('auto')).toBe('auto');
  });

  it('keeps -free suffixed ids as a distinct merge key', () => {
    expect(modelBareId('kilo/ollama-cloud/deepseek-v4-flash-free')).toBe('deepseek-v4-flash-free');
    expect(modelBareId('ollama-cloud/deepseek-v4-flash-free')).not.toBe(
      modelBareId('opencode-go/deepseek-v4-flash'),
    );
  });
});
