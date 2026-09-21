import { describe, it, expect } from 'vitest';
import { formatModelName, formatToolModel } from './model-display.js';

describe('formatModelName', () => {
  it('returns empty string for empty input', () => {
    expect(formatModelName('')).toBe('');
  });

  it.each([
    ['opencode-go/glm-5.2'],
    ['kilo/kilo-auto/free'],
    ['claude-opus-5-thinking-high'],
    ['qwen2.5-coder:7b'],
    ['gpt-4o'],
  ])('returns the id unchanged: %s', (id) => {
    expect(formatModelName(id)).toBe(id);
  });

  it('redacts a credential-shaped id', () => {
    const name = formatModelName('model sk-abcdefghijklmnopqrstuvwxyz');
    expect(name).toContain('***REDACTED***');
    expect(name.toLowerCase()).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });
});

describe('formatToolModel', () => {
  it('returns empty string when both tool and model are undefined', () => {
    expect(formatToolModel(undefined, undefined)).toBe('');
  });

  it('returns empty string when both tool and model are empty strings', () => {
    expect(formatToolModel('', '')).toBe('');
  });

  it('returns display name + separator + model for known tool', () => {
    expect(formatToolModel('ollama', 'qwen2.5-coder:7b')).toBe('Ollama \u00b7 qwen2.5-coder:7b');
  });

  it('passes through raw tool name + model for unknown tool', () => {
    expect(formatToolModel('my-provider', 'some-model')).toBe('my-provider \u00b7 some-model');
  });

  it('returns just the display name when only tool is provided', () => {
    expect(formatToolModel('ollama')).toBe('Ollama');
  });

  it('returns just the model when only model is provided', () => {
    expect(formatToolModel(undefined, 'gpt-4o')).toBe('gpt-4o');
  });

  it('redacts a credential-shaped model id in the tool line', () => {
    const line = formatToolModel('ollama', 'model sk-abcdefghijklmnopqrstuvwxyz');
    expect(line).toContain('***REDACTED***');
    expect(line.toLowerCase()).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });
});
