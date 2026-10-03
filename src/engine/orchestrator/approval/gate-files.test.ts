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
import { createInitialState } from '../../../core/state/machine.js';
import { persistApprovalEvidence } from '../evidence/persistence.js';
import { makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { TaskSpecSchema } from '../../../core/schemas/plan.js';
import { taskFromSpec } from '../../spec/plan-tasks.js';
import { planConfirmations } from './confirm.js';

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
    });

    const result = await gateChangedFiles(input);

    expect(result.allow).toBe(true);
    expect(result.changedFiles).toEqual(['src/a.ts', 'src/z.ts']);
  });

  it('gates every file after a denial and names each denied path', async () => {
    const asked: string[] = [];
    const input = makeInput({
      changedFiles: ['package.json', '.env', 'go.mod'],
      config: makeApprovalConfig({ enabled: true }),
      callbacks: {
        onApprovalNeeded: async () => ({ approved: true }),
        onComplete: () => {},
        onTieredApproval: async (request): Promise<TieredApprovalResponse> => {
          asked.push(request.actionDescription);
          return request.actionDescription === 'write go.mod'
            ? { decision: 'confirm', phrase: CONFIRM_PHRASE, reason: 'ok' }
            : { decision: 'deny', reason: 'no' };
        },
      },
    });

    const result = await gateChangedFiles(input);

    expect(asked).toEqual(['write .env', 'write go.mod', 'write package.json']);
    expect(result).toMatchObject({ allow: false, deniedFiles: ['.env', 'package.json'] });
  });

  it('returns the first rejected file and action when a later write is denied', async () => {
    const input = makeInput({
      changedFiles: ['package.json', '.env', 'package.json'],
      config: makeApprovalConfig({ enabled: true }),
      callbacks: {
        onApprovalNeeded: async () => ({ approved: true }),
        onComplete: () => {},
        onTieredApproval: async (request): Promise<TieredApprovalResponse> => {
          if (request.actionDescription === 'write .env') {
            return { decision: 'confirm', phrase: CONFIRM_PHRASE, reason: 'ok' };
          }
          return { decision: 'deny', reason: 'blocked manifest' };
        },
      },
    });

    const result = await gateChangedFiles(input);

    expect(result).toMatchObject({ allow: false, deniedFiles: ['package.json'] });
    expect(result.changedFiles).toEqual(['.env', 'package.json']);
    expect(result.actionDescription).toBe('write package.json');
    expect(result.reason).toBe('blocked manifest');
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
});

describe('protected writes an approved plan lists', () => {
  it('lets the listed write pass without a prompt and still asks for an unlisted one', async () => {
    const asked: string[] = [];
    const input = makeInput({
      changedFiles: ['package.json', '.env'],
      callbacks: {
        onApprovalNeeded: async () => ({ approved: true }),
        onComplete: () => {},
        onTieredApproval: async (request): Promise<TieredApprovalResponse> => {
          asked.push(request.actionDescription);
          return { decision: 'deny', reason: 'no' };
        },
      },
    });
    const planned = makeTask({
      file: 'src/foo.ts',
      protectedOperations: [{ path: 'package.json', operation: 'write' }],
    });
    persistApprovalEvidence({
      wctx: input,
      state: createInitialState('feature'),
      decision: { allow: true, confirmApprovals: planConfirmations([planned], input.projectDir) },
    });

    const result = await gateChangedFiles(input);

    expect(asked).toEqual(['write .env']);
    expect(result.allow).toBe(false);
    if (result.allow) return;
    expect(result.deniedFiles).toEqual(['.env']);
  });

  it.each(['./package.json', 'src/../package.json'])(
    'matches a listed %s to the package.json the gate asks about',
    async (listed) => {
      const asked: string[] = [];
      const input = makeInput({
        changedFiles: ['package.json'],
        callbacks: {
          onApprovalNeeded: async () => ({ approved: true }),
          onComplete: () => {},
          onTieredApproval: async (request): Promise<TieredApprovalResponse> => {
            asked.push(request.actionDescription);
            return { decision: 'deny', reason: 'no' };
          },
        },
      });
      const planned = taskFromSpec(
        TaskSpecSchema.parse(
          makeTaskSpec({ protectedOperations: [{ path: listed, operation: 'write' }] }),
        ),
        input.projectDir,
      );
      persistApprovalEvidence({
        wctx: input,
        state: createInitialState('feature'),
        decision: { allow: true, confirmApprovals: planConfirmations([planned], input.projectDir) },
      });

      const result = await gateChangedFiles(input);

      expect(asked).toEqual([]);
      expect(result.allow).toBe(true);
    },
  );
});
