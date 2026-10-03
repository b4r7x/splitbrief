import type { PlanProposal, TaskSpec } from '../../../src/core/schemas/plan.js';
import { taskId } from '../../../src/core/schemas/task.js';

type TaskSpecOverrides = Partial<Omit<TaskSpec, 'id' | 'dependsOn'>> & {
  id?: string;
  dependsOn?: string[];
};

export function makeTaskSpec(overrides?: TaskSpecOverrides): TaskSpec {
  const { id, dependsOn, ...rest } = overrides ?? {};
  return {
    id: taskId(id ?? 'T001'),
    title: 'Add the greeting',
    intent: 'Return a greeting for a name',
    criteria: ['C1'],
    checks: [{ id: 'K1', kind: 'test', value: 'src/hello.test.ts', required: true }],
    suggestedFiles: ['src/hello.ts'],
    contextFiles: [],
    exclusions: [],
    protectedOperations: null,
    steps: null,
    dependsOn: (dependsOn ?? []).map(taskId),
    batch: 1,
    ...rest,
  };
}

export function makePlanProposal(overrides?: Partial<PlanProposal>): PlanProposal {
  return {
    kind: 'plan',
    summary: 'Greet people by name',
    decisions: ['Keep the greeting in one module'],
    criteria: [{ id: 'C1', text: 'A name gets a greeting', checkIds: ['K1'] }],
    checks: [],
    validation: null,
    tasks: [makeTaskSpec()],
    ...overrides,
  };
}
