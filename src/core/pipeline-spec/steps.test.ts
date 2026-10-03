import { describe, expect, it } from 'vitest';
import { APPROVE_LEVELS, WORKFLOW_MODES } from '../schemas/enums.js';
import { plannerStepsFor } from './steps.js';

describe('plannerStepsFor', () => {
  it('quick is the single tasks call with no gate', () => {
    expect(plannerStepsFor('quick', 'none')).toEqual([
      { call: 'tasks', phase: 'planning', artifact: 'tasks.md', gateAfter: null, inputs: [] },
    ]);
  });

  it('standard runs research, spec, plan, tasks', () => {
    const calls = plannerStepsFor('standard', 'plan').map((step) => step.call);
    expect(calls).toEqual(['research', 'spec', 'plan', 'tasks']);
  });

  it('standard hangs the plan gate on the tasks call and no gate on the spec call', () => {
    const steps = plannerStepsFor('standard', 'plan');
    expect(steps.map((step) => step.gateAfter)).toEqual([null, null, null, 'plan']);
  });

  it('speckit runs research, spec, clarify, constitution, plan, tasks, analyze', () => {
    const calls = plannerStepsFor('speckit', 'plan').map((step) => step.call);
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

  it('speckit opens only the plan gate, after analyze', () => {
    const gated = plannerStepsFor('speckit', 'plan')
      .filter((step) => step.gateAfter !== null)
      .map((step) => [step.call, step.gateAfter]);
    expect(gated).toEqual([['analyze', 'plan']]);
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
      for (const step of plannerStepsFor(mode, 'plan')) {
        expect(step.artifact, `${mode}/${step.call}`).not.toBeNull();
      }
    }
  });

  it('a step only reads calls that ran before it', () => {
    for (const mode of WORKFLOW_MODES) {
      const seen: string[] = [];
      for (const step of plannerStepsFor(mode, 'plan')) {
        for (const input of step.inputs) expect(seen, `${mode}/${step.call}`).toContain(input);
        seen.push(step.call);
      }
    }
  });

  it('the call order never changes with the approve level', () => {
    for (const mode of WORKFLOW_MODES) {
      const base = plannerStepsFor(mode, 'plan').map((step) => step.call);
      for (const level of APPROVE_LEVELS) {
        expect(
          plannerStepsFor(mode, level).map((step) => step.call),
          `${mode}/${level}`,
        ).toEqual(base);
      }
    }
  });
});
