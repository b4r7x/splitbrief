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
import type {
  TieredApprovalRequest,
  TieredApprovalResponse,
} from '../../../core/approval/types.js';
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

  function recordingCallbacks(
    requests: TieredApprovalRequest[],
  ): GateChangedFilesInput['callbacks'] {
    return {
      onApprovalNeeded: async () => ({ approved: true }),
      onComplete: () => {},
      onTieredApproval: async (request): Promise<TieredApprovalResponse> => {
        requests.push(request);
        return { decision: 'deny', reason: 'denied' };
      },
    };
  }

  it('approves the exact declared path even when it contains spaces', async () => {
    const requests: TieredApprovalRequest[] = [];
    const result = await gateChangedFiles(
      makeInput({
        task: makeTask({ file: 'src/my app.ts' }),
        changedFiles: ['src/my app.ts'],
        config: makeApprovalConfig({ enabled: true }),
        callbacks: recordingCallbacks(requests),
      }),
    );

    expect(result.allow).toBe(true);
    expect(requests).toEqual([]);
  });

  it.each([
    { name: 'suffix of a declared file', changed: 'src/app.ts.backup', dependsOnFiles: [] },
    { name: 'declared file under another root', changed: 'other/src/app.ts', dependsOnFiles: [] },
    {
      name: 'suffix of a selected dependency',
      changed: 'src/shared/utils.ts.orig',
      dependsOnFiles: ['src/shared/utils.ts'],
    },
  ])('$name reaches the sticky tier', async ({ changed, dependsOnFiles }) => {
    const requests: TieredApprovalRequest[] = [];
    const result = await gateChangedFiles(
      makeInput({
        task: makeTask({ file: 'src/app.ts' }),
        changedFiles: [changed],
        dependsOnFiles,
        config: makeApprovalConfig({ enabled: true }),
        callbacks: recordingCallbacks(requests),
      }),
    );

    expect(result.allow).toBe(false);
    expect(result.rejectedFile).toBe(changed);
    expect(requests.map((request) => [request.tier, request.actionClass])).toEqual([
      ['sticky', 'write_out_of_scope'],
    ]);
  });

  it('writes to a selected dependency are auto-approved', async () => {
    const requests: TieredApprovalRequest[] = [];
    const result = await gateChangedFiles(
      makeInput({
        changedFiles: ['src/shared/utils.ts'],
        dependsOnFiles: ['./src/shared/utils.ts'],
        config: makeApprovalConfig({ enabled: true }),
        callbacks: recordingCallbacks(requests),
      }),
    );

    expect(result.allow).toBe(true);
    expect(requests).toEqual([]);
  });

  it('a sticky grant for app.ts does not cover its backup', async () => {
    const requests: TieredApprovalRequest[] = [];
    const input = makeInput({
      changedFiles: ['src/app.ts'],
      config: makeApprovalConfig({ enabled: true }),
      callbacks: {
        onApprovalNeeded: async () => ({ approved: true }),
        onComplete: () => {},
        onTieredApproval: async (request): Promise<TieredApprovalResponse> => {
          requests.push(request);
          return request.actionDescription === 'write src/app.ts'
            ? { decision: 'allow', scope: 'session' }
            : { decision: 'deny', reason: 'not granted' };
        },
      },
    });

    expect((await gateChangedFiles(input)).allow).toBe(true);
    expect((await gateChangedFiles(input)).allow).toBe(true);
    const backup = await gateChangedFiles({ ...input, changedFiles: ['src/app.ts.backup'] });

    expect(backup.allow).toBe(false);
    expect(backup.rejectedFile).toBe('src/app.ts.backup');
    expect(requests.map((request) => request.actionDescription)).toEqual([
      'write src/app.ts',
      'write src/app.ts.backup',
    ]);
  });
});
