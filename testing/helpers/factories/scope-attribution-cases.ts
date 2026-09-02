import type { TaskOverrides } from './task.js';

export type ScopeAttributionCase = {
  label: string;
  task: TaskOverrides;
  changedFile: string;
  accepted: boolean;
};

export const ACCEPTED_SCOPE_CASES: readonly ScopeAttributionCase[] = [
  {
    label: 'exact primary',
    task: { file: 'src/primary.ts' },
    changedFile: 'src/primary.ts',
    accepted: true,
  },
  {
    label: 'glob primary',
    task: { file: 'src/primary/*.ts' },
    changedFile: 'src/primary/matched.ts',
    accepted: true,
  },
  {
    label: 'exact in-bounds',
    task: { file: 'src/primary.ts', scope: { inBounds: ['src/in-bounds.ts'] } },
    changedFile: 'src/in-bounds.ts',
    accepted: true,
  },
  {
    label: 'glob in-bounds',
    task: { file: 'src/primary.ts', scope: { inBounds: ['src/in-bounds/**'] } },
    changedFile: 'src/in-bounds/matched.ts',
    accepted: true,
  },
  {
    label: 'exact approved',
    task: { file: 'src/primary.ts', scope: { approvedOutOfBounds: ['generated/exact.ts'] } },
    changedFile: 'generated/exact.ts',
    accepted: true,
  },
  {
    label: 'glob approved',
    task: { file: 'src/primary.ts', scope: { approvedOutOfBounds: ['generated/**'] } },
    changedFile: 'generated/matched.ts',
    accepted: true,
  },
  {
    label: 'truly untargeted',
    task: { file: 'src/primary.ts' },
    changedFile: 'unrelated/extra.ts',
    accepted: false,
  },
];
