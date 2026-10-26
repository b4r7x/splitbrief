import { describe, expect, it } from 'vitest';
import { CLI_TOOL_CATALOG } from '../../core/runners/cli-tool-catalog.js';
import { CLI_IMPLEMENTER_ADAPTERS, CLI_PLANNER_ADAPTERS } from './cli-tools/registry.js';

const CODEX_PROMPT_LIMIT = { max: 1_048_576, unit: 'characters' } as const;

describe('the adapter prompt limit', () => {
  it('declares the Codex input limit on its adapters, in characters', () => {
    expect(CLI_PLANNER_ADAPTERS.codex.promptLimit).toEqual(CODEX_PROMPT_LIMIT);
    expect(CLI_IMPLEMENTER_ADAPTERS.codex.promptLimit).toEqual(CODEX_PROMPT_LIMIT);
  });

  it('declares no limit for a tool that takes the prompt on stdin without one', () => {
    for (const adapter of [
      ...Object.values(CLI_PLANNER_ADAPTERS),
      ...Object.values(CLI_IMPLEMENTER_ADAPTERS),
    ]) {
      if (adapter.descriptor.id === 'codex') continue;
      expect(adapter.promptLimit, adapter.descriptor.id).toBeUndefined();
    }
  });

  it('is the one home of the limit: the tool catalog carries none', () => {
    for (const entry of Object.values(CLI_TOOL_CATALOG)) {
      expect(Object.keys(entry), entry.id).not.toContain('maxInputChars');
    }
  });
});
