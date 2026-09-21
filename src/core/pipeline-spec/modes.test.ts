import { describe, expect, it } from 'vitest';
import { DEFAULT_MODE, MODE_UPGRADE, MODES } from './modes.js';

describe('modes spec', () => {
  it('caps briefs at 5 in quick and 12 in standard and speckit', () => {
    expect(MODES.quick.briefCap).toBe(5);
    expect(MODES.standard.briefCap).toBe(12);
    expect(MODES.speckit.briefCap).toBe(12);
    expect(MODE_UPGRADE.standardCap).toBe(MODES.standard.briefCap);
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

  it('upgrades quick to standard past five files or five briefs', () => {
    expect(MODE_UPGRADE.quickToStandard).toEqual({ files: 5, briefs: 5 });
  });

  it('defaults the CLI to standard and the skill to quick', () => {
    expect(DEFAULT_MODE).toEqual({ cli: 'standard', skill: 'quick' });
  });
});
