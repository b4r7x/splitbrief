import { describe, expect, it } from 'vitest';
import { DEFAULT_MODE, MODES } from './modes.js';

describe('modes spec', () => {
  it('carries no brief-count limit in any mode', () => {
    for (const spec of Object.values(MODES)) expect(spec).not.toHaveProperty('briefCap');
  });

  it('opens no document gate in quick and adds plan in speckit', () => {
    expect(MODES.quick.gates).toEqual([]);
    expect(MODES.standard.gates).toEqual(['spec', 'briefs']);
    expect(MODES.speckit.gates).toEqual(['spec', 'plan', 'briefs']);
  });

  it('counts one planner call in quick, four in standard, six to seven in speckit', () => {
    expect(MODES.quick.plannerCalls).toBe(1);
    expect(MODES.standard.plannerCalls).toBe(4);
    expect(MODES.speckit.plannerCalls).toBe('6-7');
  });

  it('defaults the CLI to standard and the skill to quick', () => {
    expect(DEFAULT_MODE).toEqual({ cli: 'standard', skill: 'quick' });
  });
});
