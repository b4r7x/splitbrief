import { afterEach, describe, it, expect } from 'vitest';
import { gateChangedFiles } from './gate-files.js';
import type { GateChangedFilesInput } from './gate-files.js';
import { makeConfig, makeApprovalConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});
import type { TieredApprovalResponse } from '../../../core/approval/types.js';
import { CONFIRM_PHRASE } from '../../../core/approval/types.js';

function makeInput(overrides: Partial<GateChangedFilesInput> = {}): GateChangedFilesInput {
  const { bus } = makeBusRecorder();
  const task = makeTask({ file: 'src/foo.ts' });
  const projectDir = createTempDir('splitbrief-test');
  dirs.push(projectDir);
  return {
    changedFiles: ['src/foo.ts'],
    task,
    dependsOnFiles: [],
    projectDir,
    sessionId: 'sess-001',
    phase: 'implementing',
    taskId: task.id,
    bus,
    callbacks: {
      onApprovalNeeded: async () => ({ approved: true }),
      onComplete: () => {},
    },
    config: makeConfig(),
    ...overrides,
  };
}

describe('gateChangedFiles', () => {
  it('normalizes unsorted duplicate changed files and allows each write', async () => {
    const input = makeInput({
      changedFiles: ['src/z.ts', 'src/a.ts', 'src/z.ts'],
      config: makeApprovalConfig({ enabled: true }),
      callbacks: {
        onApprovalNeeded: async () => ({ approved: true }),
        onComplete: () => {},
        onTieredApproval: async (): Promise<TieredApprovalResponse> => ({
          decision: 'allow',
          scope: 'once',
        }),
      },
    });

    const result = await gateChangedFiles(input);

    expect(result.allow).toBe(true);
    expect(result.changedFiles).toEqual(['src/a.ts', 'src/z.ts']);
  });

  it('returns the first rejected file and action when a later write is denied', async () => {
    const input = makeInput({
      changedFiles: ['src/z.ts', 'src/a.ts', 'src/z.ts'],
      config: makeApprovalConfig({ enabled: true }),
      callbacks: {
        onApprovalNeeded: async () => ({ approved: true }),
        onComplete: () => {},
        onTieredApproval: async (request): Promise<TieredApprovalResponse> => {
          if (request.actionDescription === 'write src/a.ts') {
            return { decision: 'allow', scope: 'once' };
          }
          return { decision: 'deny', reason: 'blocked z' };
        },
      },
    });

    const result = await gateChangedFiles(input);

    expect(result.allow).toBe(false);
    expect(result.changedFiles).toEqual(['src/a.ts', 'src/z.ts']);
    expect(result.rejectedFile).toBe('src/z.ts');
    expect(result.actionDescription).toBe('write src/z.ts');
    expect(result.reason).toBe('blocked z');
  });

  it('aggregates confirm-tier approvals across package and control-plane writes', async () => {
    let confirmIndex = 0;
    const reasons = ['config plane reason', 'package manifest reason'];
    const input = makeInput({
      changedFiles: ['package.json', '.splitbrief/config.yaml', 'package.json'],
      config: makeApprovalConfig({ enabled: true }),
      callbacks: {
        onApprovalNeeded: async () => ({ approved: true }),
        onComplete: () => {},
        onTieredApproval: async (): Promise<TieredApprovalResponse> => {
          const reason = reasons[confirmIndex] ?? 'fallback reason';
          confirmIndex++;
          return { decision: 'confirm', phrase: CONFIRM_PHRASE, reason };
        },
      },
    });

    const result = await gateChangedFiles(input);

    expect(result.allow).toBe(true);
    expect(result.changedFiles).toEqual(['.splitbrief/config.yaml', 'package.json']);
    expect(result.confirmReason).toBe('config plane reason');
    expect(result.confirmApprovals).toHaveLength(2);
    expect(result.confirmApprovals?.[0]?.actionDescription).toBe('write .splitbrief/config.yaml');
    expect(result.confirmApprovals?.[1]?.actionDescription).toBe('write package.json');
    expect(result.confirmApprovals?.[0]?.reason).toBe('config plane reason');
    expect(result.confirmApprovals?.[1]?.reason).toBe('package manifest reason');
  });
});
