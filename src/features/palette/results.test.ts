import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { makeCtx } from '#testing/helpers/runtime-commands.js';
import { createRuntimeCommands } from '../../core/runtime/commands/registry.js';
import type { CommandGuardContext } from '../../core/runtime/commands/types.js';
import type { Screen } from '../../core/navigation/types.js';
import { buildPaletteResults } from './results.js';
import { buildCommandItems } from './sources.js';
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

  it('puts recently used matches first in recorded recency order after the exact name', () => {
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

    expect(results.map((result) => result.id)).toEqual([
      'command:/run',
      'command:/runner',
      'command:/run-task',
      'session:S-001',
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
            name: 'Terminal layout',
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
            name: 'Terminal layout',
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

describe('a command name typed in the palette', () => {
  const at = (
    screen: Screen,
    phase: CommandGuardContext['phase'],
    rest: Partial<CommandGuardContext> = {},
  ) => ({
    screen,
    guardContext: {
      phase,
      plannerSupportsImages: true,
      openRunAtRest: false,
      applyUnfinished: false,
      applying: false,
      ...rest,
    },
  });
  const screens = {
    home: at('home', 'idle'),
    'workflow live': at('workflow', 'implementing'),
    'workflow at rest': at('workflow', 'implementing', { openRunAtRest: true }),
    'ready run': at('workflow', 'complete', { openRunAtRest: true }),
    'closed run': at('workflow', 'complete'),
  };
  const commands = createRuntimeCommands(makeCtx());
  // Rows of the other sources whose own text holds command names.
  const others = {
    skillItems: [
      {
        id: 'crew',
        name: 'crew',
        label: 'Skill · crew',
        description: 'Sessions, settings and the home screen',
        hint: null,
        category: 'navigate' as const,
        action: run,
      },
    ],
    taskItems: [{ id: 'T001', title: 'home screen polish', action: noop }],
    sessionItems: [
      { id: 'S1', feature: 'sessions page cleanup', status: 'stopped', action: noop },
      { id: 'S2', feature: 'copy the crew rows', status: 'running', action: noop },
    ],
    customItems: [{ id: 'C1', label: 'Deploy', description: 'help copy usage', action: noop }],
  };

  for (const [screenName, { screen, guardContext }] of Object.entries(screens)) {
    const items = buildCommandItems({
      commands,
      screen,
      onRuntimeCommand: noop,
      guardContext,
    });
    const offered = items.map((item) => item.label);
    const mruLists = (name: string) => {
      const another = offered.find((label) => label !== name) ?? name;
      return [[], [`command:${another}`], ['command:/copy', 'session:S1', 'skill:crew']];
    };

    it(`ranks every name offered on ${screenName} first when typed in full, bare or with a slash`, () => {
      const misses: string[] = [];
      for (const name of offered) {
        for (const query of [name.slice(1), name]) {
          for (const mruIds of mruLists(name)) {
            const top = buildPaletteResults({
              query,
              commandItems: items,
              ...others,
              mruIds,
            })[0];
            if (top?.label !== name) misses.push(`${query} [${mruIds.join(',')}] → ${top?.label}`);
          }
        }
      }
      expect(misses).toEqual([]);
    });

    it(`ranks a command that starts with the typed prefix first on ${screenName}`, () => {
      const misses: string[] = [];
      for (const name of offered) {
        const prefix = name.slice(1, Math.max(3, name.length - 1));
        for (const mruIds of mruLists(name).slice(0, 2)) {
          const top = buildPaletteResults({
            query: prefix,
            commandItems: items,
            ...others,
            mruIds,
          })[0];
          if (top?.source !== 'command' || !top.label.startsWith(`/${prefix}`))
            misses.push(`${prefix} [${mruIds.join(',')}] → ${top?.label}`);
        }
      }
      expect(misses).toEqual([]);
    });
  }

  it.each([[[]], [['command:/copy']], [['command:/review']]])(
    'ranks /crew first for `crew review` with the recent list %j',
    (mruIds) => {
      const items = buildCommandItems({
        commands,
        screen: 'workflow',
        onRuntimeCommand: noop,
        guardContext: screens['workflow live'].guardContext,
      });
      expect(
        buildPaletteResults({ query: 'crew review', commandItems: items, ...others, mruIds })[0]
          ?.label,
      ).toBe('/crew');
    },
  );
});

describe('a row name typed in the palette', () => {
  const sourceIds = ['command', 'skill', 'task', 'session', 'custom'] as const;
  type Source = (typeof sourceIds)[number];

  function inputsOf(rows: Array<{ source: Source; id: string; name: string }>, query: string) {
    const of = (source: Source) => rows.filter((row) => row.source === source);
    return makeInputs({
      query,
      commandItems: of('command').map((row) => ({
        label: `/${row.name}`,
        description: 'A command',
        hint: null,
        shortcut: null,
        category: 'navigate' as const,
        action: run,
      })),
      skillItems: of('skill').map((row) => ({
        id: row.id,
        name: row.name,
        label: `Skill · ${row.name}`,
        description: 'A skill',
        hint: null,
        category: 'navigate' as const,
        action: run,
      })),
      taskItems: of('task').map((row) => ({ id: row.id, title: row.name, action: noop })),
      sessionItems: of('session').map((row) => ({
        id: row.id,
        feature: row.name,
        status: 'stopped',
        action: noop,
      })),
      customItems: of('custom').map((row) => ({
        id: row.id,
        label: row.name,
        description: 'A custom action',
        action: noop,
      })),
    });
  }
  const resultId = (source: Source, id: string, name: string) =>
    `${source}:${source === 'command' ? `/${name}` : id}`;

  // Each source owns one name; every source holds a row whose name starts with each owned name.
  const owned: Record<Source, string> = {
    command: 'polish',
    skill: 'splitbrief',
    task: 'verify',
    session: 'cleanup',
    custom: 'deploy',
  };
  const setRows = sourceIds.flatMap((owner) =>
    sourceIds.flatMap((source) => {
      const word = owned[owner];
      const sibling = { source, id: `${word}-run`, name: `${word}-run` };
      return source === owner ? [{ source, id: word, name: word }, sibling] : [sibling];
    }),
  );

  for (const owner of sourceIds) {
    const word = owned[owner];
    const siblings = sourceIds.map((source) => resultId(source, `${word}-run`, `${word}-run`));
    it.each([[[]], ...siblings.map((id) => [[id]])])(
      `ranks the ${owner} row named ${word} first when its name is typed, recent list %j`,
      (mruIds) => {
        const results = buildPaletteResults({ ...inputsOf(setRows, word), mruIds });
        expect(results[0]?.id).toBe(resultId(owner, word, word));
      },
    );
  }

  // A row of every other source carries the command's exact name, and a sibling that starts with it.
  const collisionRows = sourceIds.flatMap((source) => [
    { source, id: 'crew', name: source === 'custom' ? 'Crew' : 'crew' },
    { source, id: 'crew-run', name: 'crew-run' },
  ]);
  const collisionMru = sourceIds
    .filter((source) => source !== 'command')
    .flatMap((source) => [
      [resultId(source, 'crew', 'crew')],
      [resultId(source, 'crew-run', 'crew-run')],
    ]);

  it.each([[[]], ...collisionMru.map((ids) => [ids])])(
    'ranks /crew above every other row named crew, and each crew row first in its source, recent list %j',
    (mruIds) => {
      const results = buildPaletteResults({ ...inputsOf(collisionRows, 'crew'), mruIds });
      expect(results[0]?.id).toBe('command:/crew');
      for (const source of sourceIds) {
        expect(results.find((result) => result.source === source)?.id).toBe(
          resultId(source, 'crew', 'crew'),
        );
      }
      const slashed = buildPaletteResults({ ...inputsOf(collisionRows, '/crew'), mruIds });
      expect(slashed[0]?.id).toBe('command:/crew');
    },
  );

  const pipeline = ['splitbrief', 'splitbrief-brief', 'splitbrief-run', 'splitbrief-review'];
  it.each<[string, Array<{ source: Source; id: string; name: string }>, string[], string]>([
    [
      'a session that starts with the skill name',
      [
        { source: 'skill', id: 'verify', name: 'verify' },
        { source: 'session', id: 'S1', name: 'verify the login flow' },
      ],
      [],
      'skill:verify',
    ],
    [
      'that session in the recent list',
      [
        { source: 'skill', id: 'verify', name: 'verify' },
        { source: 'session', id: 'S1', name: 'verify the login flow' },
      ],
      ['session:S1'],
      'skill:verify',
    ],
    [
      'a live task that starts with the skill name',
      [
        { source: 'skill', id: 'verify', name: 'verify' },
        { source: 'task', id: 'T1', name: 'verify login form' },
      ],
      [],
      'skill:verify',
    ],
    [
      'a custom action that starts with the skill name',
      [
        { source: 'skill', id: 'deploy', name: 'deploy' },
        { source: 'custom', id: 'C1', name: 'deploy staging' },
      ],
      ['custom:C1'],
      'skill:deploy',
    ],
    [
      'the pipeline skills with a recent sibling skill',
      [
        ...pipeline.map((name) => ({ source: 'skill' as const, id: name, name })),
        { source: 'session', id: 'S1', name: 'splitbrief docs pass' },
      ],
      ['skill:splitbrief-run', 'session:S1'],
      'skill:splitbrief',
    ],
    [
      'a session whose whole name is typed',
      [
        { source: 'session', id: 'S1', name: 'verify the login flow again' },
        { source: 'session', id: 'S2', name: 'verify the login flow' },
      ],
      ['session:S1'],
      'session:S2',
    ],
  ])('ranks the typed row first against %s', (_state, rows, mruIds, expected) => {
    const name = rows.find((row) => resultId(row.source, row.id, row.name) === expected)?.name;
    const results = buildPaletteResults({ ...inputsOf(rows, name ?? ''), mruIds });
    expect(results[0]?.id).toBe(expected);
  });

  it.each(['skill verify', 'Skill · verify'])('ranks the skill first for %j', (query) => {
    const rows = [
      { source: 'skill' as const, id: 'verify', name: 'verify' },
      { source: 'session' as const, id: 'S1', name: 'verify the login flow' },
    ];
    expect(buildPaletteResults({ ...inputsOf(rows, query), mruIds: ['session:S1'] })[0]?.id).toBe(
      'skill:verify',
    );
  });

  it('orders two skills of one name by the recent list, then by their listed order', () => {
    const rows = [
      { source: 'skill' as const, id: 'project:verify', name: 'verify' },
      { source: 'skill' as const, id: 'global:verify', name: 'verify' },
      { source: 'session' as const, id: 'S1', name: 'verify the login flow' },
    ];
    const ids = (mruIds: string[]) =>
      buildPaletteResults({ ...inputsOf(rows, 'verify'), mruIds }).map((result) => result.id);
    expect(ids([])).toEqual(['skill:project:verify', 'skill:global:verify', 'session:S1']);
    expect(ids(['skill:global:verify'])).toEqual([
      'skill:global:verify',
      'skill:project:verify',
      'session:S1',
    ]);
  });
});
