import {
  ANALYZE_FILE,
  CLARIFICATIONS_FILE,
  CONSTITUTION_CHECK_FILE,
  PLAN_FILE,
  RESEARCH_FILE,
  SPEC_FILE,
  TASKS_FILE,
} from '../paths.js';
import type { ApproveLevel, Phase, WorkflowMode } from '../schemas/enums.js';
import type { GateName, PlannerCall } from '../schemas/run-step.js';
import { assertNever } from '../../utils/type-guards.js';

type PlannerStepArtifact =
  | typeof RESEARCH_FILE
  | typeof SPEC_FILE
  | typeof PLAN_FILE
  | typeof TASKS_FILE
  | typeof CLARIFICATIONS_FILE
  | typeof CONSTITUTION_CHECK_FILE
  | typeof ANALYZE_FILE;

/**
 * One planner call of a mode, in order. `phase` is what `state.json` names while
 * the call runs, `artifact` is the file whose presence memoizes it, and
 * `gateAfter` is the approval that opens once it has landed.
 */
type PlannerStep = Readonly<{
  call: PlannerCall;
  phase: Phase;
  artifact: PlannerStepArtifact | null;
  gateAfter: GateName | null;
  inputs: readonly PlannerCall[];
}>;

const RESEARCH_STEP: PlannerStep = {
  call: 'research',
  phase: 'researching',
  artifact: RESEARCH_FILE,
  gateAfter: null,
  inputs: [],
};

/**
 * The ordered planner steps a mode runs. The briefs gate is not a step: it opens
 * after the brief quality pass, downstream of every planner call.
 */
export function plannerStepsFor(
  mode: WorkflowMode,
  approveLevel: ApproveLevel,
): readonly PlannerStep[] {
  const planGate: GateName | null = approveLevel === 'plan' ? 'plan' : null;

  switch (mode) {
    case 'quick':
      return [
        { call: 'tasks', phase: 'planning', artifact: TASKS_FILE, gateAfter: null, inputs: [] },
      ];
    case 'standard':
      return [
        RESEARCH_STEP,
        {
          call: 'spec',
          phase: 'specifying',
          artifact: SPEC_FILE,
          gateAfter: null,
          inputs: ['research'],
        },
        {
          call: 'plan',
          phase: 'planning',
          artifact: PLAN_FILE,
          gateAfter: null,
          inputs: ['spec'],
        },
        {
          call: 'tasks',
          phase: 'planning',
          artifact: TASKS_FILE,
          gateAfter: planGate,
          inputs: ['spec', 'plan'],
        },
      ];
    case 'speckit':
      return [
        RESEARCH_STEP,
        {
          call: 'spec',
          phase: 'specifying',
          artifact: SPEC_FILE,
          gateAfter: null,
          inputs: ['research'],
        },
        {
          call: 'clarify',
          phase: 'clarifying',
          artifact: CLARIFICATIONS_FILE,
          gateAfter: null,
          inputs: ['spec'],
        },
        {
          call: 'constitution',
          phase: 'constitution-check',
          artifact: CONSTITUTION_CHECK_FILE,
          gateAfter: null,
          inputs: ['spec'],
        },
        {
          call: 'plan',
          phase: 'planning',
          artifact: PLAN_FILE,
          gateAfter: null,
          inputs: ['spec'],
        },
        {
          call: 'tasks',
          phase: 'planning',
          artifact: TASKS_FILE,
          gateAfter: null,
          inputs: ['spec', 'plan'],
        },
        {
          call: 'analyze',
          phase: 'analyzing',
          artifact: ANALYZE_FILE,
          gateAfter: planGate,
          inputs: ['spec', 'plan', 'tasks'],
        },
      ];
    default:
      return assertNever(mode);
  }
}

/** Whether a run's steps open the plan gate: quick mode never does, the others only at `plan`. */
export function opensPlanGate(mode: WorkflowMode, approveLevel: ApproveLevel): boolean {
  return plannerStepsFor(mode, approveLevel).some((step) => step.gateAfter === 'plan');
}
