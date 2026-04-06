import { describe, it, expect } from 'vitest';
import {
  SETTINGS_DEFS,
  getConfigValue,
  applyEdits,
  matchesFilter,
  validateNumber,
  displayValue,
  valueColor,
} from './settings-defs.js';
import type { Config } from '../types.js';

const mockConfig = {
  planner: { tool: 'claude-code', model: 'claude-sonnet-4-6' },
  implementer: {
    provider: 'ollama',
    model: 'qwen2.5-coder:7b',
    apiBase: 'http://localhost:11434/v1',
    contextLength: 32768,
    temperature: 0.3,
  },
  validation: { typecheck: true, lint: true, test: true, testCommand: 'npm test' },
  workflow: {
    autoApproveSpec: false,
    autoApprovePlan: false,
    maxRetries: 3,
    commitStrategy: 'none' as const,
    mode: 'standard' as const,
  },
  theme: 'terminal' as const,
  shikiTheme: 'github-dark',
  sessions: { scope: 'project' as const },
} satisfies Config;

describe('SETTINGS_DEFS labels', () => {
  it('all labels are human-readable (no camelCase)', () => {
    for (const def of SETTINGS_DEFS) {
      expect(
        def.label,
        `label "${def.label}" for ${def.id} contains camelCase`,
      ).not.toMatch(/[a-z][A-Z]/);
    }
  });

  it('all labels start with uppercase', () => {
    for (const def of SETTINGS_DEFS) {
      expect(def.label[0]).toBe(def.label[0].toUpperCase());
    }
  });
});

describe('displayValue with formatValue', () => {
  it('formats planner.tool with getDisplayName', () => {
    const def = SETTINGS_DEFS.find(d => d.id === 'planner.tool')!;
    expect(displayValue(def, 'claude-code', false)).toBe('[Claude Code]');
    expect(displayValue(def, 'ollama', false)).toBe('[Ollama]');
  });

  it('formats planner.model with formatModelName', () => {
    const def = SETTINGS_DEFS.find(d => d.id === 'planner.model')!;
    expect(displayValue(def, 'claude-sonnet-4-6', false)).toBe('[Claude Sonnet 4.6]');
    expect(displayValue(def, 'gpt-5.4', false)).toBe('[GPT-5.4]');
  });

  it('formats implementer.provider with getDisplayName', () => {
    const def = SETTINGS_DEFS.find(d => d.id === 'implementer.provider')!;
    expect(displayValue(def, 'lm-studio', false)).toBe('[LM Studio]');
    expect(displayValue(def, 'openrouter', false)).toBe('[OpenRouter]');
  });

  it('formats implementer.model with formatModelName', () => {
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

describe('getConfigValue', () => {
  it('reads nested dot-path values', () => {
    expect(getConfigValue(mockConfig, 'planner.tool')).toBe('claude-code');
    expect(getConfigValue(mockConfig, 'workflow.commitStrategy')).toBe('none');
    expect(getConfigValue(mockConfig, 'implementer.temperature')).toBe(0.3);
  });

  it('returns undefined for missing paths', () => {
    expect(getConfigValue(mockConfig, 'planner.nonexistent')).toBeUndefined();
    expect(getConfigValue(mockConfig, 'totally.wrong.path')).toBeUndefined();
  });
});

describe('applyEdits', () => {
  it('sets nested values immutably', () => {
    const updated = applyEdits(mockConfig, { 'workflow.commitStrategy': 'per-task' });
    expect(updated.workflow.commitStrategy).toBe('per-task');
    expect(mockConfig.workflow.commitStrategy).toBe('none');
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
