import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { buildPaletteResults } from './results.js';
import type { PaletteAction, PaletteInputs, PaletteResult, PaletteSource } from './results.js';

const noop = () => {};
const run: PaletteAction = { kind: 'run', run: noop };

function makeInputs(overrides: Partial<PaletteInputs> = {}): PaletteInputs {
  return {
    query: '',
    commandItems: [],
    skillItems: [],
    taskItems: [],
    sessionItems: [],
    customItems: [],
    mruIds: [],
    ...overrides,
  };
}

describe('buildPaletteResults', () => {
  it('shows every palette source with user-facing metadata', () => {
    const customAction = vi.fn();
    const results = buildPaletteResults(
      makeInputs({
        commandItems: [
          {
            label: '/run',
            description: 'Run it',
            hint: null,
            shortcut: 'ctrl+r',
            category: 'workflow',
            action: run,
          },
        ],
        taskItems: [{ id: 'T-001', title: 'Fix bug', action: noop }],
        sessionItems: [{ id: 'S-001', feature: 'Auth', status: 'running', action: noop }],
        customItems: [{ id: 'C-001', label: 'Deploy', description: '', action: customAction }],
      }),
    );

    expect(results.map((result) => result.id)).toEqual([
      'command:/run',
      'task:T-001',
      'session:S-001',
      'custom:C-001',
    ]);
    expect(results.map((result) => result.label)).toEqual(['/run', 'Fix bug', 'Auth', 'Deploy']);
    expect(results.map((result) => result.description)).toEqual([
      'Run it',
      'task T-001',
      'running',
      '',
    ]);
    expect(results.map((result) => result.shortcut)).toEqual(['ctrl+r', null, null, null]);

    const last = results.at(-1)?.action;
    if (last?.kind === 'run') void last.run();
    expect(customAction).toHaveBeenCalledOnce();
  });

  it('groups an unfiltered list by category in the declared category order', () => {
    const results = buildPaletteResults(
      makeInputs({
        commandItems: [
          {
            label: '/copy',
            description: 'Copy',
            hint: null,
            shortcut: null,
            category: 'io',
            action: run,
          },
          {
            label: '/crew',
            description: 'Crew',
            hint: null,
            shortcut: null,
            category: 'crew',
            action: run,
          },
          {
            label: '/home',
            description: 'Home',
            hint: null,
            shortcut: null,
            category: 'navigate',
            action: run,
          },
          {
            label: '/help',
            description: 'Help',
            hint: null,
            shortcut: null,
            category: 'navigate',
            action: run,
          },
        ],
        customItems: [{ id: 'C-001', label: 'Deploy', description: '', action: noop }],
      }),
    );

    // COMMAND_CATEGORIES is navigate → crew → workflow → view → io; uncategorised rows come last.
    expect(results.map((result) => result.label)).toEqual([
      '/home',
      '/help',
      '/crew',
      '/copy',
      'Deploy',
    ]);
  });

  it('carries a prefill action through to the result', () => {
    const results = buildPaletteResults(
      makeInputs({
        commandItems: [
          {
            label: '/crew',
            description: 'Who fills each seat',
            hint: null,
            shortcut: null,
            category: 'crew',
            action: { kind: 'prefill', text: '/crew ' },
          },
        ],
      }),
    );

    expect(results[0]?.action).toEqual({ kind: 'prefill', text: '/crew ' });
  });

  it('filters unmatched items and orders visible matches by relevance then label', () => {
    const results = buildPaletteResults(
      makeInputs({
        query: 'run',
        commandItems: [
          {
            label: '/deploy',
            description: 'Ship to prod',
            hint: null,
            shortcut: null,
            category: 'io',
            action: run,
          },
          {
            label: '/run-task',
            description: 'run a task',
            hint: null,
            shortcut: null,
            category: 'workflow',
            action: run,
          },
          {
            label: '/run',
            description: 'exact match',
            hint: null,
            shortcut: null,
            category: 'workflow',
            action: run,
          },
        ],
      }),
    );

    expect(results.map((result) => result.label)).toEqual(['/run', '/run-task']);
  });

  it('puts recently used matches first in recorded recency order', () => {
    const results = buildPaletteResults(
      makeInputs({
        query: 'run',
        commandItems: [
          {
            label: '/run',
            description: 'exact',
            hint: null,
            shortcut: null,
            category: 'workflow',
            action: run,
          },
          {
            label: '/runner',
            description: 'runner cmd',
            hint: null,
            shortcut: null,
            category: 'workflow',
            action: run,
          },
          {
            label: '/run-task',
            description: 'run a task',
            hint: null,
            shortcut: null,
            category: 'workflow',
            action: run,
          },
        ],
        sessionItems: [{ id: 'S-001', feature: 'runner rewrite', status: 'done', action: noop }],
        mruIds: ['session:S-001', 'command:/runner'],
      }),
    );

    expect(results.map((result) => result.id).slice(0, 2)).toEqual([
      'session:S-001',
      'command:/runner',
    ]);
  });

  it('does not mutate source arrays while ranking results', () => {
    const commandItems = [
      {
        label: '/run',
        description: 'run it',
        hint: null,
        shortcut: null,
        category: 'workflow' as const,
        action: run,
      },
      {
        label: '/deploy',
        description: 'deploy',
        hint: null,
        shortcut: null,
        category: 'io' as const,
        action: run,
      },
    ];
    const originalOrder = commandItems.map((item) => item.label);

    buildPaletteResults(
      makeInputs({
        query: 'run',
        commandItems,
        mruIds: ['command:/run'],
      }),
    );

    expect(commandItems.map((item) => item.label)).toEqual(originalOrder);
  });

  it('ranks a skill row beside the command rows in its category', () => {
    const toggle = vi.fn();
    const results = buildPaletteResults(
      makeInputs({
        query: 'layout',
        commandItems: [
          {
            label: '/skills',
            description: 'Attach project skills',
            hint: null,
            shortcut: null,
            category: 'navigate',
            action: run,
          },
        ],
        skillItems: [
          {
            id: 'terminal-layout',
            label: 'Skill · Terminal layout',
            description: 'Check spacing and terminal-width behavior',
            hint: 'attached',
            category: 'navigate',
            action: { kind: 'run', run: toggle },
          },
        ],
      }),
    );

    expect(results.map((result) => result.id)).toEqual(['skill:terminal-layout']);
    expect(results[0]).toMatchObject({ source: 'skill', category: 'navigate', hint: 'attached' });

    const action = results[0]?.action;
    if (action?.kind === 'run') void action.run();
    expect(toggle).toHaveBeenCalledOnce();
  });

  it('exports a source union that covers every source a result carries', () => {
    const results = buildPaletteResults(
      makeInputs({
        commandItems: [
          {
            label: '/skills',
            description: 'Attach project skills',
            hint: null,
            shortcut: null,
            category: 'navigate',
            action: run,
          },
        ],
        skillItems: [
          {
            id: 'terminal-layout',
            label: 'Skill · Terminal layout',
            description: 'Check spacing',
            hint: null,
            category: 'navigate',
            action: run,
          },
        ],
        taskItems: [{ id: 'T-001', title: 'Fix bug', action: noop }],
        sessionItems: [{ id: 'S-001', feature: 'Auth', status: 'running', action: noop }],
        customItems: [{ id: 'C-001', label: 'Deploy', description: '', action: noop }],
      }),
    );

    const sources: PaletteSource[] = results.map((result) => result.source);
    expect(sources).toEqual(['command', 'skill', 'task', 'session', 'custom']);
    expectTypeOf<PaletteResult['source']>().toEqualTypeOf<PaletteSource>();
  });
});
