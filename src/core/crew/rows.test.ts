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
  it('lays the seats out with their branches, escalate hanging under build', () => {
    expect(keysOf(makeConfig())).toEqual([
      'seat:plan',
      'effort:plan',
      'seat:build',
      'escalate',
      'seat:review',
    ]);
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

  it('gives the build seat an effort row when its api model reasons', () => {
    const config = makeConfig({
      implementer: { kind: 'api', provider: 'anthropic', model: 'claude-sonnet-4' },
    });

    expect(keysOf(config)).toContain('effort:build');
  });

  it('keeps the escalate row even with no intermediate model configured', () => {
    expect(rowAt(deriveCrewRows({ config: makeConfig() }), 'escalate')).toMatchObject({
      entry: undefined,
    });
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

  it('matches the escalate row by its own word and by the model it points at', () => {
    const config = makeConfig({
      escalation: { intermediateProvider: 'deepseek', intermediateModel: 'deepseek-chat' },
    });
    const text = crewRowFilterText(rowAt(deriveCrewRows({ config }), 'escalate'));

    expect(text).toContain('escalate');
    expect(text).toContain('deepseek');
  });
});
