import { describe, it, expect } from 'vitest';
import { getErrorHint, formatErrorWithHint } from './error-hints.js';

describe('getErrorHint', () => {
  it('matches ECONNREFUSED on Ollama port 11434', () => {
    const hint = getErrorHint('connect ECONNREFUSED 127.0.0.1:11434');
    expect(hint?.message).toBe('Ollama is not running');
    expect(hint?.hint).toContain('ollama serve');
  });

  it('matches ECONNREFUSED on LM Studio port 1234', () => {
    const hint = getErrorHint('connect ECONNREFUSED 127.0.0.1:1234');
    expect(hint?.message).toBe('LM Studio is not running');
    expect(hint?.hint).toContain('application');
  });

  it('matches generic ECONNREFUSED on unknown ports', () => {
    const hint = getErrorHint('connect ECONNREFUSED 127.0.0.1:9999');
    expect(hint?.message).toBe('Cannot connect to provider');
  });

  it('matches 401 Unauthorized', () => {
    const hint = getErrorHint('API error 401 from deepseek: Unauthorized');
    expect(hint?.message).toBe('Invalid API key');
    expect(hint?.hint).toContain('API_KEY');
  });

  it('matches 429 Too Many Requests', () => {
    const hint = getErrorHint('API error 429 from openrouter: Too Many Requests');
    expect(hint?.message).toBe('Rate limited by provider');
    expect(hint?.hint).toContain('retry');
  });

  it('matches rate_limit error codes', () => {
    const hint = getErrorHint('rate_limit_exceeded');
    expect(hint?.message).toBe('Rate limited by provider');
  });

  it('matches ENOTFOUND', () => {
    const hint = getErrorHint('getaddrinfo ENOTFOUND api.example.com');
    expect(hint?.message).toBe('Cannot reach host');
    expect(hint?.hint).toContain('network');
  });

  it('matches model not found errors', () => {
    const hint = getErrorHint('model "llama3" not found');
    expect(hint?.message).toBe('Model not available');
    expect(hint?.hint).toContain('ollama pull');
  });

  it('matches model_not_found error codes', () => {
    const hint = getErrorHint('Error: model_not_found');
    expect(hint?.message).toBe('Model not available');
  });

  it('matches context_length_exceeded', () => {
    const hint = getErrorHint("context_length_exceeded: model's max context length is 8192");
    expect(hint?.message).toBe('Input too long for model');
    expect(hint?.hint).toContain('larger context');
  });

  it('does not match 401 embedded in larger numbers', () => {
    expect(getErrorHint('port 40100')).toBeUndefined();
  });

  it('does not match 429 embedded in larger numbers', () => {
    expect(getErrorHint('error code 42900')).toBeUndefined();
  });

  it('does not match rate limit with arbitrary separator', () => {
    expect(getErrorHint('rateXlimit')).toBeUndefined();
  });

  it('returns undefined for unknown errors', () => {
    expect(getErrorHint('something completely different')).toBeUndefined();
  });
});

describe('formatErrorWithHint', () => {
  it('returns enriched message for known errors', () => {
    const result = formatErrorWithHint('connect ECONNREFUSED 127.0.0.1:11434');
    expect(result).toBe('Ollama is not running\n  → Start it with: ollama serve');
  });

  it('returns original message for unknown errors', () => {
    const msg = 'some random error';
    expect(formatErrorWithHint(msg)).toBe(msg);
  });
});
