import type { Task } from '../../../src/core/schemas/task.js';
import { taskId as brand } from '../../../src/core/schemas/task.js';

type TaskOverrides = Omit<Partial<Task>, 'id' | 'dependsOn'> & {
  id?: string;
  dependsOn?: string[];
};

export function makeTask(overrides?: TaskOverrides): Task {
  const { id, dependsOn, ...rest } = overrides ?? {};
  return {
    id: brand(id ?? 'T001'),
    title: 'Create hello module',
    action: 'create',
    file: 'src/hello.ts',
    dependsOn: (dependsOn ?? []).map(brand),
    description: 'Create a hello world module',
    tests: ['returns the expected greeting'],
    constraints: [],
    typeDefs: '',
    implementationSteps: ['1. Implement the module'],
    status: 'pending',
    ...rest,
  };
}
