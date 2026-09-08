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
  const STABLE_SEAT_KEYS = ['seat:plan', 'seat:build', 'seat:review'] as const;

  it('lays the seats out with exactly one row per seat', () => {
    expect(keysOf(makeConfig())).toEqual(STABLE_SEAT_KEYS);
  });

  it('returns three rows and exactly the three seat keys for catalogued, custom-endpoint, and configured-reviewer configs', () => {
    const configs = [
      makeConfig(),
      makeConfig({
        implementer: {
          kind: 'api',
          provider: 'custom-endpoint',
          model: 'claude-sonnet-4',
          apiBase: 'https://api.example.test/v1',
          apiKey: 'test-key',
        },
      }),
      makeConfig({
        reviewer: { kind: 'cli', tool: 'codex' },
      }),
    ];

    for (const config of configs) {
      const rows = deriveCrewRows({ config });
      expect(rows).toHaveLength(3);
      expect(rows.map(crewRowKey)).toEqual(STABLE_SEAT_KEYS);
    }
  });

  it('keeps the YAML-only escalation config out of the crew rows', () => {
    const rows = deriveCrewRows({
      config: makeConfig({
        escalation: { intermediateProvider: 'ollama', intermediateModel: 'llama3.1' },
      }),
    });

    expect(rows.map(crewRowKey)).toEqual(STABLE_SEAT_KEYS);
  });

  it('returns exactly 3 rows with stable keys for every runner kind and inheritance combo', () => {
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
            expect(rows).toHaveLength(3);
            expect(rows.map(crewRowKey)).toEqual(STABLE_SEAT_KEYS);
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

  it('matches an effort level from the seat identity', () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4', effort: 'high' },
    });
    const text = crewRowFilterText(rowAt(deriveCrewRows({ config }), 'seat:plan'));

    expect(text).toContain('high');
  });
});
