import { describe, it, expect } from 'vitest';
import { getErrorHint, formatErrorWithHint } from './error-hints.js';

describe('getErrorHint', () => {
  it.each([
    ['connect ECONNREFUSED 127.0.0.1:11434', 'Ollama is not running', 'ollama serve'],
    ['connect ECONNREFUSED 127.0.0.1:1234', 'LM Studio is not running', 'application'],
    ['connect ECONNREFUSED 127.0.0.1:9999', 'Cannot connect to provider', undefined],
    ['API error 401 from deepseek: Unauthorized', 'Invalid API key', 'API_KEY'],
    ['API error 429 from openrouter: Too Many Requests', 'Rate limited by provider', 'retry'],
    ['rate_limit_exceeded', 'Rate limited by provider', undefined],
    ['getaddrinfo ENOTFOUND api.example.com', 'Cannot reach host', 'network'],
    ['model "llama3" not found', 'Model not available', 'ollama pull'],
    ['Error: model_not_found', 'Model not available', undefined],
    [
      "context_length_exceeded: model's max context length is 8192",
      'Input too long for model',
      'larger context',
    ],
  ])('matches %j -> %s', (input, expectedMessage, hintSubstring) => {
    const hint = getErrorHint(input);
    expect(hint?.message).toBe(expectedMessage);
    if (hintSubstring) expect(hint?.hint).toContain(hintSubstring);
  });

  it.each([
    ['port 40100'],
    ['error code 42900'],
    ['rateXlimit'],
    ['something completely different'],
  ])('does not match %j', (input) => {
    expect(getErrorHint(input)).toBeUndefined();
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
