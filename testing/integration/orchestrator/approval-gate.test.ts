import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInitialState, transition } from '../../../src/core/state/machine.js';
import { SPEC_FILE } from '../../../src/core/paths.js';
import { ensureSessionDir, writeSpecFile } from '../../../src/core/paths-io.js';
import { runApprovalLoop } from '../../../src/engine/orchestrator/approval/loop.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { ApprovalReviewResult } from '../../../src/core/approval/types.js';
import {
  makeCallbacks,
  makeBusRecorder,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { resetAllStores } from '#testing/helpers/stores.js';

type ApprovalResolution = ApprovalReviewResult;

const dirs: string[] = [];

async function expectStillPending(promise: Promise<unknown>): Promise<void> {
  const outcome = await Promise.race([
    promise.then(() => 'settled'),
    new Promise<string>((resolve) => {
      setTimeout(() => resolve('pending'), 25);
    }),
  ]);
  expect(outcome).toBe('pending');
}

beforeEach(() => resetAllStores());
afterEach(() => {
  while (dirs.length) cleanupTempDir(dirs.pop() as string);
});

describe('spec approval gate suspends until externally resolved', () => {
  it('suspends until the approval promise resolves, then returns an accepted result', async () => {
    const projectDir = createTempDir('orch-int-approval');
    dirs.push(projectDir);
    const sessionId = 'sess-approval';
    ensureSessionDir(projectDir, sessionId);
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec', null);

    let approve: ((value: ApprovalResolution) => void) | undefined;
    const approval = new Promise<ApprovalResolution>((resolve) => {
      approve = resolve;
    });
    const approvalArgs: unknown[] = [];
    const onApprovalNeeded = (kind: unknown, input: unknown): Promise<ApprovalResolution> => {
      approvalArgs.push(kind, input);
      return approval;
    };
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus, events } = makeBusRecorder();

    let state = createInitialState('feat');
    state = transition(state, { type: 'START' });

    const loopPromise = runApprovalLoop({
      type: 'spec',
      filePath: '/tmp/spec.md',
      planner: makePlanner(),
      projectDir,
      sessionId,
      callbacks,
      bus,
      state,
    });

    await expectStillPending(loopPromise);
    expect(approvalArgs).toEqual(['spec', '/tmp/spec.md']);

    expect(approve).toBeDefined();
    approve?.({ approved: true });
    const result = await loopPromise;

    expect(result.rejected).toBe(false);
    expect(result.regenerated).toBe(false);
    expect(events.find((e) => e.type === 'spec_rejected')).toBeUndefined();
    expect(events.find((e) => e.type === 'planner_status' && e.status === 'done')).toBeUndefined();
  });
});
