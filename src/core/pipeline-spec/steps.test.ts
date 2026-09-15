import { describe, expect, it } from 'vitest';
import { APPROVE_LEVELS, WORKFLOW_MODES } from '../schemas/enums.js';
import { resolveApproveLevel } from '../config/runtime/resolve.js';
import { MODES } from './modes.js';
import { plannerStepsFor } from './steps.js';

describe('plannerStepsFor', () => {
  it('quick is the single tasks call with no gate', () => {
    expect(plannerStepsFor('quick', 'none')).toEqual([
      { call: 'tasks', phase: 'planning', artifact: 'tasks.md', gateAfter: null, inputs: [] },
    ]);
  });

  it('standard runs research, spec, plan, tasks', () => {
    const calls = plannerStepsFor('standard', 'spec').map((step) => step.call);
    expect(calls).toEqual(['research', 'spec', 'plan', 'tasks']);
  });

  it('standard hangs the spec gate on the spec call and the plan gate on the tasks call', () => {
    const all = plannerStepsFor('standard', 'all');
    expect(all.map((step) => step.gateAfter)).toEqual([null, 'spec', null, 'plan']);
  });

  it('speckit runs research, spec, clarify, constitution, plan, tasks, analyze', () => {
    const calls = plannerStepsFor('speckit', 'all').map((step) => step.call);
    expect(calls).toEqual([
      'research',
      'spec',
      'clarify',
      'constitution',
      'plan',
      'tasks',
      'analyze',
    ]);
  });

  it('speckit opens the spec gate after the constitution check and the plan gate after analyze', () => {
    const gated = plannerStepsFor('speckit', 'all')
      .filter((step) => step.gateAfter !== null)
      .map((step) => [step.call, step.gateAfter]);
    expect(gated).toEqual([
      ['constitution', 'spec'],
      ['analyze', 'plan'],
    ]);
  });

  it('an approve level that does not block a gate leaves the step gateless', () => {
    expect(plannerStepsFor('standard', 'none').map((step) => step.gateAfter)).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(plannerStepsFor('standard', 'plan').map((step) => step.gateAfter)).toEqual([
      null,
      null,
      null,
      'plan',
    ]);
  });

  it('every step names the artifact that memoizes it', () => {
    for (const mode of WORKFLOW_MODES) {
      for (const step of plannerStepsFor(mode, 'all')) {
        expect(step.artifact, `${mode}/${step.call}`).not.toBeNull();
      }
    }
  });

  it('a step only reads calls that ran before it', () => {
    for (const mode of WORKFLOW_MODES) {
      const seen: string[] = [];
      for (const step of plannerStepsFor(mode, 'all')) {
        for (const input of step.inputs) expect(seen, `${mode}/${step.call}`).toContain(input);
        seen.push(step.call);
      }
    }
  });

  // At a mode's own approve level the gates it hangs on its steps are exactly the document
  // gates it declares. `--approve all` is the operator asking for more than that, so the table
  // is read at the level the mode resolves to on its own.
  it('the gates a mode can open are the document gates the pipeline spec declares', () => {
    for (const mode of WORKFLOW_MODES) {
      const level = resolveApproveLevel({ mode, configApprove: 'default' });
      const opened = new Set(
        plannerStepsFor(mode, level)
          .map((step) => step.gateAfter)
          .filter((gate) => gate !== null),
      );
      const declared = MODES[mode].gates.filter((gate) => gate !== 'briefs');
      expect([...opened].sort(), mode).toEqual([...declared].sort());
    }
  });

  it('the call order never changes with the approve level', () => {
    for (const mode of WORKFLOW_MODES) {
      const base = plannerStepsFor(mode, 'all').map((step) => step.call);
      for (const level of APPROVE_LEVELS) {
        expect(
          plannerStepsFor(mode, level).map((step) => step.call),
          `${mode}/${level}`,
        ).toEqual(base);
      }
    }
  });
});
