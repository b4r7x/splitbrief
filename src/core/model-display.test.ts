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
    expect(formatToolModel({})).toBe('');
  });

  it('returns empty string when both tool and model are empty strings', () => {
    expect(formatToolModel({ tool: '', model: '' })).toBe('');
  });

  it('returns display name + separator + model for known tool', () => {
    expect(formatToolModel({ tool: 'ollama', model: 'qwen2.5-coder:7b' })).toBe(
      'Ollama \u00b7 qwen2.5-coder:7b',
    );
  });

  it('passes through raw tool name + model for unknown tool', () => {
    expect(formatToolModel({ tool: 'my-provider', model: 'some-model' })).toBe(
      'my-provider \u00b7 some-model',
    );
  });

  it('returns just the display name when only tool is provided', () => {
    expect(formatToolModel({ tool: 'ollama' })).toBe('Ollama');
  });

  it('returns just the model when only model is provided', () => {
    expect(formatToolModel({ model: 'gpt-4o' })).toBe('gpt-4o');
  });

  it('redacts a credential-shaped model id in the tool line', () => {
    const line = formatToolModel({ tool: 'ollama', model: 'model sk-abcdefghijklmnopqrstuvwxyz' });
    expect(line).toContain('***REDACTED***');
    expect(line.toLowerCase()).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('keeps a custom API provider literal even when it reuses a CLI tool id', () => {
    expect(formatToolModel({ tool: 'opencode', model: 'gpt-5', kind: 'api' })).toBe(
      'opencode \u00b7 gpt-5',
    );
    expect(formatToolModel({ tool: 'claude-code', kind: 'api' })).toBe('claude-code');
  });

  it('resolves a CLI call named by its command through the tool it starts', () => {
    expect(formatToolModel({ tool: 'claude', kind: 'cli' })).toBe('Claude Code CLI');
  });

  it('keeps shell and agent call names literal', () => {
    expect(formatToolModel({ tool: 'opencode', model: 'gpt-5', kind: 'shell' })).toBe(
      'opencode \u00b7 gpt-5',
    );
    expect(formatToolModel({ tool: 'claude', kind: 'agent' })).toBe('claude');
  });
});
