import { describe, it, expect } from 'vitest';
import { SETTINGS_DEFS } from '../../core/settings/catalog.js';
import { matchesFilter, validateNumber, displayValue } from './presentation.js';
import { glyph } from '../../lib/glyphs.js';

function getDef(id: string) {
  const def = SETTINGS_DEFS.find((candidate) => candidate.id === id);
  if (!def) throw new Error(`Missing setting definition: ${id}`);
  return def;
}

describe('displayValue with formatValue', () => {
  it('formats tool fields with getDisplayName', () => {
    const def = getDef('planner.kind');
    expect(displayValue(def, 'claude-code')).toBe('Claude Code');
    expect(displayValue(def, 'ollama')).toBe('Ollama');
  });

  it('formats model fields with formatModelName', () => {
    const def = getDef('implementer.model');
    expect(displayValue(def, 'qwen2.5-coder:7b')).toBe('Qwen 2.5 Coder 7B');
    expect(displayValue(def, 'deepseek-chat')).toBe('DeepSeek V3');
  });

  it('shows raw value for defs without formatValue', () => {
    const def = getDef('validation.testCommand');
    expect(displayValue(def, 'npm test')).toBe('npm test');
  });

  it('shows ✓ for true and off for false booleans', () => {
    const def = getDef('validation.typecheck');
    expect(displayValue(def, true)).toBe(glyph('check'));
    expect(displayValue(def, false)).toBe('off');
  });

  it('— stays the default for defless fields', () => {
    const def = getDef('planner.model');
    expect(displayValue(def, undefined)).toBe('—');
    expect(displayValue(def, null)).toBe('—');
  });

  it('auto (256K) when value equals detectedContextLength', () => {
    expect(
      displayValue(getDef('implementer.contextLength'), 256_000, {
        detectedContextLength: 256_000,
      }),
    ).toBe('auto (256K)');
  });

  it('unsetLabel fallbacks for effort/timeout/contextLength', () => {
    expect(displayValue(getDef('planner.effort'), undefined)).toBe('auto (tool default)');
    expect(displayValue(getDef('implementer.timeout'), null)).toBe('auto (idle kill 30m)');
    expect(displayValue(getDef('implementer.contextLength'), undefined)).toBe('auto');
  });
});

describe('matchesFilter', () => {
  it('matches on label', () => {
    const def = getDef('workflow.git.commitStrategy');
    expect(matchesFilter(def, 'commit')).toBe(true);
    expect(matchesFilter(def, 'Strategy')).toBe(true);
  });

  it('matches on section', () => {
    const def = getDef('workflow.mode');
    expect(matchesFilter(def, 'workflow')).toBe(true);
  });
});

describe('validateNumber', () => {
  it('rejects non-numeric', () => {
    const def = getDef('workflow.maxRetries');
    expect(validateNumber('abc', def)).toBeNull();
  });

  it('rejects out of range', () => {
    const def = getDef('workflow.maxRetries');
    expect(validateNumber('-1', def)).toBeNull();
    expect(validateNumber('99', def)).toBeNull();
  });

  it('rejects empty numeric buffers', () => {
    const def = getDef('workflow.maxRetries');
    expect(validateNumber('', def)).toBeNull();
    expect(validateNumber('   ', def)).toBeNull();
  });

  it('accepts valid integer', () => {
    const def = getDef('workflow.maxRetries');
    expect(validateNumber('5', def)).toBe(5);
  });

  it('rejects non-integer for integer fields', () => {
    const def = getDef('workflow.maxRetries');
    expect(validateNumber('3.5', def)).toBeNull();
  });

  it('accepts schema-valid context windows beyond the old 131072 cap', () => {
    const def = getDef('implementer.contextLength');
    expect(validateNumber('200000', def)).toBe(200000);
    expect(validateNumber('1000000', def)).toBe(1000000);
  });
});
