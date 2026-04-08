import { describe, it, expect } from 'vitest';
import { SETTINGS_DEFS } from './catalog.js';
import {
  matchesFilter,
  validateNumber,
  displayValue,
  valueColor,
} from '../../components/overlays/settings-overlay/settings-presentation.js';

describe('displayValue with formatValue', () => {
  it('formats tool fields with getDisplayName', () => {
    const def = SETTINGS_DEFS.find(d => d.id === 'planner.tool')!;
    expect(displayValue(def, 'claude-code', false)).toBe('[Claude Code]');
    expect(displayValue(def, 'ollama', false)).toBe('[Ollama]');
  });

  it('formats model fields with formatModelName', () => {
    const def = SETTINGS_DEFS.find(d => d.id === 'implementer.model')!;
    expect(displayValue(def, 'qwen2.5-coder:7b', false)).toBe('[Qwen 2.5 Coder 7B]');
    expect(displayValue(def, 'deepseek-chat', false)).toBe('[DeepSeek V3]');
  });

  it('shows raw value for defs without formatValue', () => {
    const def = SETTINGS_DEFS.find(d => d.id === 'validation.testCommand')!;
    expect(displayValue(def, 'npm test', false)).toBe('[npm test]');
  });

  it('shows disabled placeholder', () => {
    const def = SETTINGS_DEFS.find(d => d.id === 'planner.model')!;
    expect(displayValue(def, 'claude-sonnet-4-6', true)).toBe('[\u2014]');
  });

  it('shows boolean checkmarks', () => {
    const def = SETTINGS_DEFS.find(d => d.id === 'validation.typecheck')!;
    expect(displayValue(def, true, false)).toBe('[\u2713]');
    expect(displayValue(def, false, false)).toBe('[\u2717]');
  });

  it('shows null placeholder for undefined values', () => {
    const def = SETTINGS_DEFS.find(d => d.id === 'planner.model')!;
    expect(displayValue(def, undefined, false)).toBe('[\u2014]');
    expect(displayValue(def, null, false)).toBe('[\u2014]');
  });
});

describe('matchesFilter', () => {
  it('matches on label', () => {
    const def = SETTINGS_DEFS.find(d => d.id === 'workflow.commitStrategy')!;
    expect(matchesFilter(def, 'commit')).toBe(true);
    expect(matchesFilter(def, 'Strategy')).toBe(true);
  });

  it('matches on section', () => {
    const def = SETTINGS_DEFS.find(d => d.id === 'workflow.mode')!;
    expect(matchesFilter(def, 'workflow')).toBe(true);
  });
});

describe('validateNumber', () => {
  it('rejects non-numeric', () => {
    const def = SETTINGS_DEFS.find(d => d.id === 'workflow.maxRetries')!;
    expect(validateNumber('abc', def)).toBeNull();
  });

  it('rejects out of range', () => {
    const def = SETTINGS_DEFS.find(d => d.id === 'workflow.maxRetries')!;
    expect(validateNumber('-1', def)).toBeNull();
    expect(validateNumber('99', def)).toBeNull();
  });

  it('accepts valid integer', () => {
    const def = SETTINGS_DEFS.find(d => d.id === 'workflow.maxRetries')!;
    expect(validateNumber('5', def)).toBe(5);
  });

  it('rejects non-integer for integer fields', () => {
    const def = SETTINGS_DEFS.find(d => d.id === 'workflow.maxRetries')!;
    expect(validateNumber('3.5', def)).toBeNull();
  });
});
