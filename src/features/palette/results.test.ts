import { describe, expect, it, vi } from 'vitest';
import { buildPaletteResults } from './results.js';
import type { PaletteInputs } from './results.js';

const noop = () => {};

function makeInputs(overrides: Partial<PaletteInputs> = {}): PaletteInputs {
  return {
    query: '',
    commandItems: [],
    modeItems: [],
    pickerItems: [],
    taskItems: [],
    sessionItems: [],
    customItems: [],
    mruIds: [],
    ...overrides,
  };
}

describe('buildPaletteResults', () => {
  describe('empty query', () => {
    it('returns all items in source-priority order without MRU', () => {
      const inputs = makeInputs({
        commandItems: [{ label: 'Run', description: 'Run it', shortcut: null, action: noop, availableOn: [] }],
        modeItems: [{ label: 'Standard', description: 'Standard mode', action: noop }],
        pickerItems: [{ label: 'File', description: 'Pick file', action: noop }],
        taskItems: [{ id: 'T-001', title: 'Fix bug', action: noop }],
        sessionItems: [{ id: 'S-001', feature: 'Auth', status: 'running', action: noop }],
        customItems: [{ id: 'C-001', label: 'Deploy', description: 'Deploy to prod', action: noop }],
      });
      const results = buildPaletteResults(inputs);
      expect(results.map((r) => r.source)).toEqual(['command', 'mode', 'picker', 'task', 'session', 'custom']);
    });

    it('sorts MRU items first by recency while preserving source order for non-MRU items', () => {
      const inputs = makeInputs({
        commandItems: [{ label: 'Zulu', description: 'Run it', shortcut: null, action: noop, availableOn: [] }],
        modeItems: [{ label: 'Alpha', description: 'Standard mode', action: noop }],
        pickerItems: [{ label: 'Beta', description: 'Pick file', action: noop }],
        taskItems: [{ id: 'T-001', title: 'Fix bug', action: noop }],
        sessionItems: [{ id: 'S-001', feature: 'Auth', status: 'running', action: noop }],
        customItems: [{ id: 'C-001', label: 'Deploy', description: 'Deploy to prod', action: noop }],
        mruIds: ['task:T-001', 'command:Zulu'],
      });
      const results = buildPaletteResults(inputs);
      expect(results.map((r) => r.id)).toEqual([
        'task:T-001',
        'command:Zulu',
        'mode:Alpha',
        'picker:Beta',
        'session:S-001',
        'custom:C-001',
      ]);
    });

    it('sets score to 0 for all items', () => {
      const inputs = makeInputs({
        commandItems: [{ label: 'Run', description: 'Run it', shortcut: null, action: noop, availableOn: [] }],
      });
      const results = buildPaletteResults(inputs);
      expect(results.every((r) => r.score === 0)).toBe(true);
    });
  });

  describe('non-matching query', () => {
    it('returns empty array when nothing matches', () => {
      const inputs = makeInputs({
        query: 'zzzzzzzzzzzzzzzzzzzzz',
        commandItems: [{ label: 'Run', description: 'Run it', shortcut: null, action: noop, availableOn: [] }],
        modeItems: [{ label: 'Standard', description: 'Standard mode', action: noop }],
      });
      const results = buildPaletteResults(inputs);
      expect(results).toHaveLength(0);
    });
  });

  describe('matching query', () => {
    it('returns only matching items', () => {
      const inputs = makeInputs({
        query: 'run',
        commandItems: [
          { label: 'Run tests', description: 'Execute tests', shortcut: null, action: noop, availableOn: [] },
          { label: 'Deploy', description: 'Deploy to prod', shortcut: null, action: noop, availableOn: [] },
        ],
      });
      const results = buildPaletteResults(inputs);
      expect(results).toHaveLength(1);
      expect(results[0]?.label).toBe('Run tests');
    });

    it('sorts matching items by descending score', () => {
      const inputs = makeInputs({
        query: 'run',
        commandItems: [
          { label: 'run', description: 'exact match', shortcut: null, action: noop, availableOn: [] },
          { label: 'Runner extended', description: 'runs', shortcut: null, action: noop, availableOn: [] },
        ],
      });
      const results = buildPaletteResults(inputs);
      expect(results[0]?.score).toBeGreaterThanOrEqual(results[1]?.score ?? 0);
    });
  });

  describe('MRU ordering', () => {
    it('MRU items appear first regardless of score', () => {
      const inputs = makeInputs({
        query: 'run',
        commandItems: [
          { label: 'run', description: 'exact match', shortcut: null, action: noop, availableOn: [] },
          { label: 'Run task', description: 'run a task', shortcut: null, action: noop, availableOn: [] },
        ],
        modeItems: [{ label: 'Runner', description: 'runner mode', action: noop }],
        mruIds: ['mode:Runner'],
      });
      const results = buildPaletteResults(inputs);
      expect(results[0]?.id).toBe('mode:Runner');
    });

    it('within MRU, rank 1 (most recently used) comes first', () => {
      const inputs = makeInputs({
        query: 'run',
        commandItems: [
          { label: 'run', description: 'exact', shortcut: null, action: noop, availableOn: [] },
          { label: 'Runner', description: 'runner cmd', shortcut: null, action: noop, availableOn: [] },
        ],
        mruIds: ['command:Runner', 'command:run'],
      });
      const results = buildPaletteResults(inputs);
      const mruResults = results.filter((r) => r.mruRank > 0);
      expect(mruResults[0]?.id).toBe('command:Runner');
      expect(mruResults[1]?.id).toBe('command:run');
    });

    it('mruRank is 1 for index 0 in mruIds, 0 for absent ids', () => {
      const inputs = makeInputs({
        commandItems: [
          { label: 'Run', description: 'run it', shortcut: null, action: noop, availableOn: [] },
          { label: 'Deploy', description: 'deploy', shortcut: null, action: noop, availableOn: [] },
        ],
        mruIds: ['command:Run', 'command:Other'],
      });
      const results = buildPaletteResults(inputs);
      const run = results.find((r) => r.id === 'command:Run');
      const deploy = results.find((r) => r.id === 'command:Deploy');
      expect(run?.mruRank).toBe(1);
      expect(deploy?.mruRank).toBe(0);
    });
  });

  describe('non-MRU tie-break', () => {
    it('sorts alphabetically by label when scores are equal', () => {
      // "apple" and "azure" are same length (5), same description "desc", same source "mode"
      // query "a" matches at position 0 (word boundary) in both with identical score
      const inputs = makeInputs({
        query: 'a',
        modeItems: [
          { label: 'azure', description: 'desc', action: noop },
          { label: 'apple', description: 'desc', action: noop },
        ],
      });
      const results = buildPaletteResults(inputs);
      expect(results[0]?.label).toBe('apple');
      expect(results[1]?.label).toBe('azure');
    });
  });

  describe('id format', () => {
    it('produces correct id prefixes for each source', () => {
      const inputs = makeInputs({
        commandItems: [{ label: 'Run', description: '', shortcut: null, action: noop, availableOn: [] }],
        modeItems: [{ label: 'Quick', description: '', action: noop }],
        pickerItems: [{ label: 'File', description: '', action: noop }],
        taskItems: [{ id: 'T-001', title: 'Fix bug', action: noop }],
        sessionItems: [{ id: 'S-001', feature: 'Auth', status: 'running', action: noop }],
        customItems: [{ id: 'C-001', label: 'Deploy', description: '', action: noop }],
      });
      const results = buildPaletteResults(inputs);
      const ids = results.map((r) => r.id);
      expect(ids).toContain('command:Run');
      expect(ids).toContain('mode:Quick');
      expect(ids).toContain('picker:File');
      expect(ids).toContain('task:T-001');
      expect(ids).toContain('session:S-001');
      expect(ids).toContain('custom:C-001');
    });
  });

  describe('fuzzyMatchExtended exclusion', () => {
    it('excludes item when fuzzyMatchExtended returns null', () => {
      const inputs = makeInputs({
        query: 'xyz',
        commandItems: [
          { label: 'abc def', description: 'ghi jkl', shortcut: null, action: noop, availableOn: [] },
        ],
      });
      const results = buildPaletteResults(inputs);
      expect(results).toHaveLength(0);
    });
  });

  describe('custom items', () => {
    it('custom items with empty description default to empty string in target', () => {
      const action = vi.fn();
      const inputs = makeInputs({
        query: 'deploy',
        customItems: [{ id: 'C-001', label: 'deploy', description: '', action }],
      });
      const results = buildPaletteResults(inputs);
      expect(results).toHaveLength(1);
      expect(results[0]?.description).toBe('');
    });
  });

  describe('does not mutate inputs', () => {
    it('does not mutate input arrays', () => {
      const commandItems = [
        { label: 'Run', description: 'run it', shortcut: null, action: noop, availableOn: [] as const },
        { label: 'Deploy', description: 'deploy', shortcut: null, action: noop, availableOn: [] as const },
      ];
      const originalOrder = commandItems.map((i) => i.label);
      buildPaletteResults(makeInputs({ query: 'run', commandItems }));
      expect(commandItems.map((i) => i.label)).toEqual(originalOrder);
    });
  });

  describe('shortcut field', () => {
    it('carries shortcut from command items', () => {
      const inputs = makeInputs({
        commandItems: [{ label: 'Run', description: 'run it', shortcut: 'ctrl+r', action: noop, availableOn: [] }],
      });
      const results = buildPaletteResults(inputs);
      expect(results[0]?.shortcut).toBe('ctrl+r');
    });

    it('null shortcut passes through', () => {
      const inputs = makeInputs({
        commandItems: [{ label: 'Run', description: 'run it', shortcut: null, action: noop, availableOn: [] }],
      });
      const results = buildPaletteResults(inputs);
      expect(results[0]?.shortcut).toBeNull();
    });

    it('non-command sources have null shortcut', () => {
      const inputs = makeInputs({
        modeItems: [{ label: 'Quick', description: 'quick mode', action: noop }],
      });
      const results = buildPaletteResults(inputs);
      expect(results[0]?.shortcut).toBeNull();
    });
  });
});
