import { describe, expect, it } from 'vitest';
import { ChangedFilesSnapshotSchema, WorkflowStateSchema } from './workflow.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';

const tokenUsage = makeUsage();

const task = {
  id: 'T001',
  title: 'Do work',
  action: 'modify',
  file: 'src/a.ts',
  dependsOn: [],
  description: 'Do work',
  tests: [],
  constraints: [],
  typeDefs: '',
  implementationSteps: [],
  status: 'pending',
};

function state(
  overrides: Partial<{
    phase: string;
    currentTaskIndex: number;
    tasks: (typeof task)[];
  }> = {},
) {
  return {
    stateVersion: 4,
    stateRevision: 1,
    phase: 'reviewing-briefs',
    feature: 'quality recovery',
    currentTaskIndex: 0,
    attempt: 0,
    tasks: [],
    startedAt: '2026-08-13T00:00:00.000Z',
    tokenUsage,
    ...overrides,
  };
}

describe('WorkflowStateSchema v4', () => {
  it('parses the complete changed-files snapshot contract', () => {
    const snapshot = {
      head: 'abc123',
      files: ['src/a.ts'],
      dirtyFileContents: { 'src/a.ts': 'before\n' },
      gitlinks: ['vendor/module'],
      baselineFileHashes: { 'src/a.ts': 'hash' },
      ignoreProjectDir: '/tmp/staged-project',
    };

    expect(ChangedFilesSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it('requires v4 persistence identity and rejects v3 or future state versions', () => {
    expect(WorkflowStateSchema.safeParse({ ...state(), stateVersion: 3 }).success).toBe(false);
    expect(WorkflowStateSchema.safeParse({ ...state(), stateVersion: 5 }).success).toBe(false);
    expect(WorkflowStateSchema.safeParse({ ...state(), stateRevision: undefined }).success).toBe(
      false,
    );
  });

  it('legacy v4 keys are stripped on parse', () => {
    const parsed = WorkflowStateSchema.safeParse({
      ...state(),
      briefRecovery: { junk: true },
      generation: null,
      permit: null,
      authorityRevision: 3,
      stateFence: { token: 1, ownerId: 'x' },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty('briefRecovery');
      expect(parsed.data).not.toHaveProperty('generation');
      expect(parsed.data).not.toHaveProperty('permit');
      expect(parsed.data).not.toHaveProperty('authorityRevision');
      expect(parsed.data).not.toHaveProperty('stateFence');
    }
  });

  it('retains task graph and active-index invariants under v4', () => {
    expect(
      WorkflowStateSchema.safeParse(state({ tasks: [task, { ...task, title: 'Duplicate' }] }))
        .success,
    ).toBe(false);
    expect(
      WorkflowStateSchema.safeParse(state({ phase: 'validating-task', tasks: [] })).success,
    ).toBe(false);
    expect(
      WorkflowStateSchema.safeParse(
        state({ phase: 'implementing', currentTaskIndex: 2, tasks: [task] }),
      ).success,
    ).toBe(false);
    expect(
      WorkflowStateSchema.safeParse(
        state({
          phase: 'implementing',
          currentTaskIndex: 1,
          tasks: [{ ...task, status: 'done' }],
        }),
      ).success,
    ).toBe(true);
  });

  it('rejects unknown top-level persisted fields instead of silently accepting them', () => {
    expect(
      WorkflowStateSchema.safeParse({
        ...state(),
        clarifications: [{ id: 'c1', question: 'q', answer: 'a' }],
      }).success,
    ).toBe(false);
  });
});
