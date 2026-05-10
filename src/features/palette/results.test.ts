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
  it('shows every palette source in default order with user-facing metadata', () => {
    const customAction = vi.fn();
    const results = buildPaletteResults(makeInputs({
      commandItems: [{ label: 'Run', description: 'Run it', shortcut: 'ctrl+r', action: noop, availableOn: [] }],
      modeItems: [{ label: 'Standard', description: 'Standard mode', action: noop }],
      pickerItems: [{ label: 'File', description: 'Pick file', action: noop }],
      taskItems: [{ id: 'T-001', title: 'Fix bug', action: noop }],
      sessionItems: [{ id: 'S-001', feature: 'Auth', status: 'running', action: noop }],
      customItems: [{ id: 'C-001', label: 'Deploy', description: '', action: customAction }],
    }));

    expect(results.map((result) => result.id)).toEqual([
      'command:Run',
      'mode:Standard',
      'picker:File',
      'task:T-001',
      'session:S-001',
      'custom:C-001',
    ]);
    expect(results.map((result) => result.label)).toEqual([
      'Run',
      'Standard',
      'File',
      'Fix bug',
      'Auth',
      'Deploy',
    ]);
    expect(results.map((result) => result.description)).toEqual([
      'Run it',
      'Standard mode',
      'Pick file',
      'Task T-001',
      'running',
      '',
    ]);
    expect(results.map((result) => result.shortcut)).toEqual([
      'ctrl+r',
      null,
      null,
      null,
      null,
      null,
    ]);

    results.at(-1)?.action();
    expect(customAction).toHaveBeenCalledOnce();
  });

  it('filters unmatched items and orders visible matches by relevance then label', () => {
    const matchingResults = buildPaletteResults(makeInputs({
      query: 'run',
      commandItems: [
        { label: 'Deploy', description: 'Ship to prod', shortcut: null, action: noop, availableOn: [] },
        { label: 'Run task', description: 'run a task', shortcut: null, action: noop, availableOn: [] },
        { label: 'run', description: 'exact match', shortcut: null, action: noop, availableOn: [] },
      ],
    }));

    expect(matchingResults.map((result) => result.label)).toEqual(['run', 'Run task']);
    expect(matchingResults.some((result) => result.label === 'Deploy')).toBe(false);

    const tiedResults = buildPaletteResults(makeInputs({
      query: 'a',
      modeItems: [
        { label: 'azure', description: 'desc', action: noop },
        { label: 'apple', description: 'desc', action: noop },
      ],
    }));

    expect(tiedResults.map((result) => result.label)).toEqual(['apple', 'azure']);
  });

  it('puts recently used matches first in recorded recency order', () => {
    const results = buildPaletteResults(makeInputs({
      query: 'run',
      commandItems: [
        { label: 'run', description: 'exact', shortcut: null, action: noop, availableOn: [] },
        { label: 'Runner', description: 'runner cmd', shortcut: null, action: noop, availableOn: [] },
        { label: 'Run task', description: 'run a task', shortcut: null, action: noop, availableOn: [] },
      ],
      modeItems: [{ label: 'Runner mode', description: 'runner mode', action: noop }],
      mruIds: ['mode:Runner mode', 'command:Runner'],
    }));

    expect(results.map((result) => result.id).slice(0, 2)).toEqual([
      'mode:Runner mode',
      'command:Runner',
    ]);
  });

  it('does not mutate source arrays while ranking results', () => {
    const commandItems = [
      { label: 'Run', description: 'run it', shortcut: null, action: noop, availableOn: [] as const },
      { label: 'Deploy', description: 'deploy', shortcut: null, action: noop, availableOn: [] as const },
    ];
    const originalOrder = commandItems.map((item) => item.label);

    buildPaletteResults(makeInputs({
      query: 'run',
      commandItems,
      mruIds: ['command:Run'],
    }));

    expect(commandItems.map((item) => item.label)).toEqual(originalOrder);
  });
});
