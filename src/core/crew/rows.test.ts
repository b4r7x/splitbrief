import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { crewRowFilterText, crewRowKey, deriveCrewRows, type CrewRow } from './rows.js';

function keysOf(config: Parameters<typeof deriveCrewRows>[0]['config']): readonly string[] {
  return deriveCrewRows({ config }).map(crewRowKey);
}

function rowAt(rows: readonly CrewRow[], key: string): CrewRow {
  const row = rows.find((candidate) => crewRowKey(candidate) === key);
  if (row === undefined) throw new Error(`no ${key} row`);
  return row;
}

describe('deriveCrewRows', () => {
  const STABLE_SIX_KEYS = [
    'seat:plan',
    'effort:plan',
    'seat:build',
    'effort:build',
    'seat:review',
    'effort:review',
  ] as const;

  it('lays the seats out with exactly 6 rows', () => {
    expect(keysOf(makeConfig())).toEqual(STABLE_SIX_KEYS);
  });

  it('shows an inherited review seat the planner effort, read-only', () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4', effort: 'high' },
    });
    const rows = deriveCrewRows({ config });

    expect(rows.map(crewRowKey).at(-1)).toBe('effort:review');
    expect(rowAt(rows, 'effort:review')).toMatchObject({
      value: 'high',
      editable: false,
      inherited: true,
    });
  });

  it('keeps the build effort row in place but undeliverable on an api seat', () => {
    const config = makeConfig({
      implementer: { kind: 'api', provider: 'ollama', model: 'llama3.1' },
    });

    expect(keysOf(config)).toEqual(STABLE_SIX_KEYS);
    expect(rowAt(deriveCrewRows({ config }), 'effort:build')).toMatchObject({
      deliverable: false,
      editable: false,
    });
  });

  it('says the variant, not n/a, on an opencode seat', () => {
    const config = makeConfig({
      implementer: {
        kind: 'cli',
        tool: 'opencode',
        model: 'openai/gpt-5.6-luna',
        variant: 'xhigh',
      },
    });
    const row = rowAt(deriveCrewRows({ config }), 'effort:build');

    expect(row).toMatchObject({
      channel: 'variant',
      value: 'xhigh',
      deliverable: true,
      editable: true,
    });
    expect(crewRowFilterText(row)).not.toContain('n/a');
  });

  // A variant channel delivers only what its provider spells, so a seat with no
  // ladder to walk must not read as editable.
  it.each([
    ['no model at all', undefined],
    ['a provider outside the preset table', 'opencode-go/gpt-5.6-luna'],
  ])('marks an opencode seat with %s uneditable', (_name, model) => {
    const config = makeConfig({
      implementer: { kind: 'cli', tool: 'opencode', ...(model === undefined ? {} : { model }) },
    });

    expect(rowAt(deriveCrewRows({ config }), 'effort:build')).toMatchObject({
      channel: 'variant',
      deliverable: true,
      editable: false,
    });
  });

  it('shows a cursor seat its id-spelled effort read-only', () => {
    const config = makeConfig({
      implementer: { kind: 'cli', tool: 'cursor', model: 'gpt-5.6-luna-high-fast' },
    });

    expect(rowAt(deriveCrewRows({ config }), 'effort:build')).toMatchObject({
      channel: 'model-id',
      value: 'high',
      deliverable: true,
      editable: false,
    });
  });

  it('still says n/a on a channel-less seat', () => {
    const config = makeConfig({
      implementer: {
        kind: 'api',
        provider: 'ollama',
        service: 'ollama',
        offering: 'local',
        apiBase: 'http://127.0.0.1:11434/v1',
        model: 'qwen3-coder:30b',
      },
    });
    const row = rowAt(deriveCrewRows({ config }), 'effort:build');

    expect(row).toMatchObject({ channel: 'none', deliverable: false });
    expect(crewRowFilterText(row)).toBe('effort n/a');
  });

  it('mirrors the planner channel onto an inherited review row', () => {
    const config = makeConfig({
      planner: {
        kind: 'cli',
        tool: 'opencode',
        model: 'openai/gpt-5.6-luna',
        variant: 'xhigh',
      },
    });

    expect(rowAt(deriveCrewRows({ config }), 'effort:review')).toMatchObject({
      inherited: true,
      editable: false,
      channel: 'variant',
      value: 'xhigh',
    });
  });

  it('keeps the YAML-only escalation config out of the crew rows', () => {
    const rows = deriveCrewRows({
      config: makeConfig({
        escalation: { intermediateProvider: 'ollama', intermediateModel: 'llama3.1' },
      }),
    });

    expect(rows.map(crewRowKey)).toEqual(STABLE_SIX_KEYS);
  });

  it('returns exactly 6 rows with stable keys for every runner kind and inheritance combo', () => {
    const samplePlanners = [
      { kind: 'cli' as const, tool: 'claude-code' as const, model: 'claude-sonnet-4' },
      { kind: 'cli' as const, tool: 'opencode' as const, model: 'qwen2.5-coder' },
      {
        kind: 'api' as const,
        provider: 'custom-endpoint' as const,
        model: 'acme/reasoner-1',
        apiBase: 'https://api.example.test/v1',
      },
      { kind: 'shell' as const, command: 'echo test', model: 'custom-model' },
      { kind: 'agent' as const, command: 'agent', model: 'custom-model' },
    ];
    const sampleImplementers = [
      ...samplePlanners,
      {
        kind: 'api' as const,
        provider: 'ollama' as const,
        model: 'llama3',
        apiBase: 'http://localhost:11434/v1',
      },
    ];
    const sampleReviewers = [undefined, ...samplePlanners];

    for (const planner of samplePlanners) {
      for (const implementer of sampleImplementers) {
        for (const reviewer of sampleReviewers) {
          for (const effort of [undefined, 'low', 'high'] as const) {
            const config = makeConfig({
              planner: effort ? { ...planner, effort } : planner,
              implementer: effort ? { ...implementer, effort } : implementer,
              ...(reviewer !== undefined && {
                reviewer: effort ? { ...reviewer, effort } : reviewer,
              }),
            });
            const rows = deriveCrewRows({ config });
            expect(rows).toHaveLength(6);
            expect(rows.map(crewRowKey)).toEqual(STABLE_SIX_KEYS);
          }
        }
      }
    }
  });
});

describe('crewRowFilterText', () => {
  it('matches a seat by its label and by any word of its identity', () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4' },
    });
    const text = crewRowFilterText(rowAt(deriveCrewRows({ config }), 'seat:plan'));

    expect(text).toContain('plan');
    expect(text).toContain('sonnet');
    expect(text).not.toContain('·');
  });

  it('keeps a version number whole so the user can type it', () => {
    const config = makeConfig({
      implementer: { kind: 'api', provider: 'ollama', model: 'qwen2.5-coder:7b' },
    });
    const text = crewRowFilterText(rowAt(deriveCrewRows({ config }), 'seat:build'));

    expect(text).toContain('qwen 2.5');
  });

  it('matches an effort row by the word effort and its current position', () => {
    const rows = deriveCrewRows({ config: makeConfig() });

    expect(crewRowFilterText(rowAt(rows, 'effort:plan'))).toBe('effort auto');
  });
});
