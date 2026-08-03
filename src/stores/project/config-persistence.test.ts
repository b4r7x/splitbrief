import { describe, expect, it } from 'vitest';
import { createDefaultConfig } from '../../core/config/load/io.js';
import { deriveConfigEdits, persistedConfigForSave } from './config-persistence.js';

describe('config persistence', () => {
  it('keeps an unchanged effective override out of the persisted config', () => {
    const persisted = createDefaultConfig();
    const effective = {
      ...persisted,
      implementer: { ...persisted.implementer, model: 'one-shot-override' },
    };

    const result = persistedConfigForSave({
      persisted,
      effective,
      updated: { ...effective, theme: 'mono' },
    });

    expect(result.theme).toBe('mono');
    expect(result.implementer.model).toBe(persisted.implementer.model);
  });

  it('derives snake-case path edits and deletions without unchanged siblings', () => {
    const before = {
      ...createDefaultConfig(),
      implementer: {
        kind: 'api' as const,
        provider: 'ollama',
        service: 'ollama',
        offering: 'local' as const,
        apiBase: 'http://localhost:11434/v1',
        model: 'qwen3-coder:30b',
        contextLength: 32768,
      },
    };
    const after = {
      ...before,
      implementer: {
        kind: 'cli' as const,
        tool: 'codex' as const,
        model: 'gpt-5.4-mini',
      },
    };

    expect(deriveConfigEdits(before, after)).toEqual(
      expect.arrayContaining([
        { path: ['implementer', 'kind'], value: 'cli' },
        { path: ['implementer', 'tool'], value: 'codex' },
        { path: ['implementer', 'api_base'], value: undefined },
        { path: ['implementer', 'context_length'], value: undefined },
      ]),
    );
  });
});
