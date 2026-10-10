import { describe, it, expect } from 'vitest';
import { formatModelName, formatToolModel } from './model-display.js';
import { getProviderDisplayName } from './providers/catalog.js';
import { formatShortSeatIdentity } from './crew/identity.js';

describe('formatModelName', () => {
  it('returns empty string for empty input', () => {
    expect(formatModelName('')).toBe('');
  });

  it.each([
    ['opencode-go/glm-5.2', 'GLM 5.2'],
    ['kilo/kilo-auto/free', 'Kilo Auto Free'],
    ['claude-opus-5-thinking-high', 'Claude Opus 5 Thinking High'],
    ['qwen2.5-coder:7b', 'Qwen2.5 Coder 7B'],
    ['gpt-4o', 'GPT-4o'],
  ])('spells an id no provider row names as its pretty name: %s', (id, name) => {
    expect(formatModelName(id)).toBe(name);
  });

  it('keeps the automatic model as its own word, the one the crew identity shows', () => {
    expect(formatModelName('auto')).toBe('auto');
    expect(formatModelName('default', 'claude-code')).toBe('auto');
  });

  it('redacts a credential-shaped id', () => {
    const name = formatModelName('model sk-abcdefghijklmnopqrstuvwxyz');
    expect(name).toContain('***REDACTED***');
    expect(name.toLowerCase()).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('spells a known id with its provider row label', () => {
    expect(formatModelName('claude-opus-5-5', 'claude-code')).toBe('Opus 5.5');
  });

  it('prettifies a namespaced id when no provider is given', () => {
    expect(formatModelName('deepseek/deepseek-flash')).toBe('DeepSeek Flash');
  });
});

describe('formatToolModel', () => {
  it('returns empty string when both tool and model are undefined', () => {
    expect(formatToolModel({})).toBe('');
  });

  it('returns empty string when both tool and model are empty strings', () => {
    expect(formatToolModel({ tool: '', model: '' })).toBe('');
  });

  it('returns display name + separator + pretty model for known tool', () => {
    expect(formatToolModel({ tool: 'ollama', model: 'qwen2.5-coder:7b' })).toBe(
      'Ollama \u00b7 Qwen2.5 Coder 7B',
    );
  });

  it('passes through raw tool name + pretty model for unknown tool', () => {
    expect(formatToolModel({ tool: 'my-provider', model: 'some-model' })).toBe(
      'my-provider \u00b7 Some Model',
    );
  });

  it('returns just the display name when only tool is provided', () => {
    expect(formatToolModel({ tool: 'ollama' })).toBe('Ollama');
  });

  it('returns just the pretty model when only model is provided', () => {
    expect(formatToolModel({ model: 'gpt-4o' })).toBe('GPT-4o');
  });

  it('redacts a credential-shaped model id in the tool line', () => {
    const line = formatToolModel({ tool: 'ollama', model: 'model sk-abcdefghijklmnopqrstuvwxyz' });
    expect(line).toContain('***REDACTED***');
    expect(line.toLowerCase()).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('keeps a custom API provider word literal and spells its model pretty when it reuses a CLI tool id', () => {
    expect(formatToolModel({ tool: 'opencode', model: 'gpt-5', kind: 'api' })).toBe(
      'opencode \u00b7 GPT-5',
    );
    expect(formatToolModel({ tool: 'claude-code', kind: 'api' })).toBe('claude-code');
  });

  it('resolves a CLI call named by its command through the tool it starts', () => {
    expect(formatToolModel({ tool: 'claude', kind: 'cli' })).toBe('Claude Code CLI');
  });

  it('keeps shell and agent call names literal and spells their model pretty', () => {
    expect(formatToolModel({ tool: 'opencode', model: 'gpt-5', kind: 'shell' })).toBe(
      'opencode \u00b7 GPT-5',
    );
    expect(formatToolModel({ tool: 'claude', kind: 'agent' })).toBe('claude');
  });

  it('reads a CLI alias label only for a CLI call, as the seat identity does', () => {
    expect(formatToolModel({ tool: 'claude-code', model: 'opus', kind: 'shell' })).toBe(
      'claude-code \u00b7 Opus',
    );
    expect(
      formatShortSeatIdentity({ seat: { tool: 'claude-code', model: 'opus' }, kind: 'shell' }),
    ).toBe('Opus');
    expect(formatToolModel({ tool: 'claude-code', model: 'opus', kind: 'cli' })).toBe(
      'Claude Code CLI \u00b7 Opus 5.5',
    );
    expect(formatToolModel({ tool: 'claude-code', model: 'opus' })).toBe(
      'Claude Code CLI \u00b7 Opus 5.5',
    );
  });

  it('prefers a resolved display name over re-spelling the model id', () => {
    expect(
      formatToolModel({ tool: 'codex', model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol' }),
    ).toBe(`${getProviderDisplayName('codex')} \u00b7 GPT-6.1 Sol`);
  });
});

describe('formatModelName before any catalog is cached', () => {
  // A cold project names a seat from the bundled rows; a warm one from the tool's own listing.
  // Both must spell the model the way the tool does, or home and the workflow screen disagree.
  it.each([
    ['codex', 'gpt-6-astra', 'GPT-6-Astra'],
    ['codex', 'gpt-6.1-sol', 'GPT-6.1-Sol'],
    ['antigravity', 'gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)'],
  ])('spells %s %s as the tool lists it', (tool, model, label) => {
    expect(formatModelName(model, tool)).toBe(label);
  });
});
