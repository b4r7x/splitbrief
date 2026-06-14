import { describe, it, expect } from 'vitest';
import { getConfigValue, applyEdits } from './values.js';
import { makeConfig } from '#testing/helpers/factories/config.js';

const mockConfig = makeConfig({
  planner: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4-6' },
  implementer: { temperature: 0.3 },
  theme: 'terminal',
  sessions: { scope: 'project' },
});

describe('getConfigValue', () => {
  it('reads nested dot-path values', () => {
    expect(getConfigValue(mockConfig, 'planner.tool')).toBe('claude-code');
    expect(getConfigValue(mockConfig, 'workflow.commitStrategy')).toBe('none');
    expect(getConfigValue(mockConfig, 'implementer.temperature')).toBe(0.3);
  });

  it('reads top-level values', () => {
    expect(getConfigValue(mockConfig, 'theme')).toBe('terminal');
    expect(getConfigValue(mockConfig, 'sessions.scope')).toBe('project');
  });

  it('returns undefined for missing paths', () => {
    expect(getConfigValue(mockConfig, 'planner.nonexistent')).toBeUndefined();
    expect(getConfigValue(mockConfig, 'totally.wrong.path')).toBeUndefined();
  });

  it('returns undefined when traversing through a non-object', () => {
    expect(getConfigValue(mockConfig, 'theme.nested')).toBeUndefined();
  });
});

describe('applyEdits', () => {
  it('sets nested values immutably', () => {
    const updated = applyEdits(mockConfig, { 'workflow.commitStrategy': 'per-task' });
    expect(updated.workflow.commitStrategy).toBe('per-task');
    expect(mockConfig.workflow.commitStrategy).toBe('none');
  });

  it('applies multiple edits at once', () => {
    const updated = applyEdits(mockConfig, {
      'workflow.mode': 'quick',
      'implementer.temperature': 0.7,
    });
    expect(updated.workflow.mode).toBe('quick');
    expect(updated.implementer.temperature).toBe(0.7);
  });

  it('creates intermediate objects for new paths', () => {
    const updated = applyEdits(mockConfig, { 'planner.outputFormat': 'stream-json' });
    expect((updated.planner as Record<string, unknown>).outputFormat).toBe('stream-json');
  });

  it('does not mutate the original config', () => {
    const original = structuredClone(mockConfig);
    applyEdits(mockConfig, { theme: 'mono' });
    expect(mockConfig).toEqual(original);
  });

  it('throws on edits that produce an invalid config', () => {
    expect(() => applyEdits(mockConfig, { 'implementer.model': '' })).toThrow();
  });
});
