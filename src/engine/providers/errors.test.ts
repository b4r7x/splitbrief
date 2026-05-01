import { describe, expect, test } from 'vitest';
import { matches } from '../../utils/error.js';
import { providerError } from './errors.js';

describe('providerError factories', () => {
  test('unknownNeedsApiBase names the provider', () => {
    const err = providerError.unknownNeedsApiBase('bogus');
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe('provider-unknown-needs-api-base');
    expect(err.message).toContain('bogus');
    expect(err.data).toEqual({ name: 'bogus' });
  });

  test('unknownNeedsApiKey names the provider', () => {
    const err = providerError.unknownNeedsApiKey('bogus');
    expect(err.kind).toBe('provider-unknown-needs-api-key');
    expect(err.data).toEqual({ name: 'bogus' });
  });

  test('notApi records the received kind', () => {
    const err = providerError.notApi('cli');
    expect(err.kind).toBe('provider-not-api');
    expect(err.message).toContain('cli');
    expect(err.data).toEqual({ kind: 'cli' });
  });

  test('anthropicNotOpenAICompat has no data payload', () => {
    const err = providerError.anthropicNotOpenAICompat();
    expect(err.kind).toBe('provider-anthropic-not-openai-compat');
    expect(err.message).toContain('Anthropic');
    expect(err.data).toBeUndefined();
  });

  test('missingModel records role', () => {
    const err = providerError.missingModel('planner');
    expect(err.kind).toBe('provider-missing-model');
    expect(err.message).toContain('planner');
    expect(err.data).toEqual({ role: 'planner' });
  });

  test('expectedOpenAIClient records provider', () => {
    const err = providerError.expectedOpenAIClient('ollama');
    expect(err.kind).toBe('provider-expected-openai-client');
    expect(err.data).toEqual({ provider: 'ollama' });
  });

  test('httpFailure carries status + url', () => {
    const err = providerError.httpFailure(503, 'https://api.example/v1');
    expect(err.kind).toBe('provider-http-failure');
    expect(err.message).toBe('HTTP 503');
    expect(err.data).toEqual({ status: 503, url: 'https://api.example/v1' });
  });
});

describe('providerError kinds via matches()', () => {
  test('matches() rejects non-AppError values', () => {
    expect(matches('provider-http-failure')(new Error('plain'))).toBe(false);
    expect(matches('provider-http-failure')(null)).toBe(false);
    expect(matches('provider-http-failure')('string')).toBe(false);
  });

  test('matches() narrows http-failure data to { status, url }', () => {
    const err: unknown = providerError.httpFailure(418, 'https://teapot');
    if (matches('provider-http-failure')(err)) {
      expect(err.data).toEqual({ status: 418, url: 'https://teapot' });
    } else {
      throw new Error('predicate should match');
    }
  });
});
