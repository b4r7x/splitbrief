import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInitialState, transition } from '../../../src/core/state/machine.js';
import { SPEC_FILE } from '../../../src/core/paths.js';
import { ensureSessionDir, writeSpecFile } from '../../../src/core/paths-io.js';
import { runApprovalLoop } from '../../../src/engine/orchestrator/approval/approval.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  makeCallbacks,
  makeBusRecorder,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { resetAllStores } from '#testing/helpers/stores.js';

type ApprovalResolution = { approved: boolean; comment?: string | undefined };

const dirs: string[] = [];

beforeEach(() => resetAllStores());
afterEach(() => {
  while (dirs.length) cleanupTempDir(dirs.pop() as string);
});

describe('spec approval gate suspends until externally resolved', () => {
  it('awaits onApprovalNeeded, resumes on resolve, then emits spec-approved-equivalent state transition', async () => {
    const projectDir = createTempDir('orch-int-approval');
    dirs.push(projectDir);
    const sessionId = 'sess-approval';
    ensureSessionDir(projectDir, sessionId);
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec', null);

    let approve: ((value: ApprovalResolution) => void) | undefined;
    const approval = new Promise<ApprovalResolution>((resolve) => {
      approve = resolve;
    });
    const onApprovalNeeded = (): Promise<ApprovalResolution> => approval;
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus, events } = makeBusRecorder();

    let state = createInitialState('feat');
    state = transition(state, { type: 'START', feature: 'feat' });

    const loopPromise = runApprovalLoop({
      type: 'spec',
      filePath: '/tmp/spec.md',
      planner: makePlanner(),
      projectDir,
      sessionId,
      callbacks,
      bus,
      state,
      persistTranscript: false,
    });

    await Promise.resolve();
    const resolved = { kind: 'none' } as { kind: 'none' | 'done' };
    void loopPromise.then(() => {
      resolved.kind = 'done';
    });
    await Promise.resolve();
    expect(resolved.kind).toBe('none');

    expect(approve).toBeDefined();
    approve?.({ approved: true });
    const result = await loopPromise;

    expect(result.rejected).toBe(false);
    expect(result.regenerated).toBe(false);
    expect(events.find((e) => e.type === 'planner_status' && e.status === 'done')).toBeUndefined();
  });
});
