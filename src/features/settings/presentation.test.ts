import { describe, it, expect } from 'vitest';
import { SETTINGS_DEFS } from '../../core/settings/catalog.js';
import { matchesFilter, validateNumber, displayValue } from './presentation.js';

describe('displayValue with formatValue', () => {
  it('formats tool fields with getDisplayName', () => {
    const def = SETTINGS_DEFS.find((d) => d.id === 'planner.kind')!;
    expect(displayValue(def, 'claude-code')).toBe('[Claude Code]');
    expect(displayValue(def, 'ollama')).toBe('[Ollama]');
  });

  it('formats model fields with formatModelName', () => {
    const def = SETTINGS_DEFS.find((d) => d.id === 'implementer.model')!;
    expect(displayValue(def, 'qwen2.5-coder:7b')).toBe('[Qwen 2.5 Coder 7B]');
    expect(displayValue(def, 'deepseek-chat')).toBe('[DeepSeek V3]');
  });

  it('shows raw value for defs without formatValue', () => {
    const def = SETTINGS_DEFS.find((d) => d.id === 'validation.testCommand')!;
    expect(displayValue(def, 'npm test')).toBe('[npm test]');
  });

  it('shows boolean checkmarks', () => {
    const def = SETTINGS_DEFS.find((d) => d.id === 'validation.typecheck')!;
    expect(displayValue(def, true)).toBe('[✓]');
    expect(displayValue(def, false)).toBe('[✗]');
  });

  it('shows null placeholder for undefined values', () => {
    const def = SETTINGS_DEFS.find((d) => d.id === 'planner.model')!;
    expect(displayValue(def, undefined)).toBe('[—]');
    expect(displayValue(def, null)).toBe('[—]');
  });
});

describe('matchesFilter', () => {
  it('matches on label', () => {
    const def = SETTINGS_DEFS.find((d) => d.id === 'workflow.git.commitStrategy')!;
    expect(matchesFilter(def, 'commit')).toBe(true);
    expect(matchesFilter(def, 'Strategy')).toBe(true);
  });

  it('matches on section', () => {
    const def = SETTINGS_DEFS.find((d) => d.id === 'workflow.mode')!;
    expect(matchesFilter(def, 'workflow')).toBe(true);
  });

  it('includes compaction format in workflow settings', () => {
    const def = SETTINGS_DEFS.find((d) => d.id === 'workflow.compactionFormat');
    expect(def).toMatchObject({
      kind: 'enum',
      options: ['auto', 'freeform', 'structured'],
    });
  });
});

describe('validateNumber', () => {
  it('rejects non-numeric', () => {
    const def = SETTINGS_DEFS.find((d) => d.id === 'workflow.maxRetries')!;
    expect(validateNumber('abc', def)).toBeNull();
  });

  it('rejects out of range', () => {
    const def = SETTINGS_DEFS.find((d) => d.id === 'workflow.maxRetries')!;
    expect(validateNumber('-1', def)).toBeNull();
    expect(validateNumber('99', def)).toBeNull();
  });

  it('accepts valid integer', () => {
    const def = SETTINGS_DEFS.find((d) => d.id === 'workflow.maxRetries')!;
    expect(validateNumber('5', def)).toBe(5);
  });

  it('rejects non-integer for integer fields', () => {
    const def = SETTINGS_DEFS.find((d) => d.id === 'workflow.maxRetries')!;
    expect(validateNumber('3.5', def)).toBeNull();
  });
});
