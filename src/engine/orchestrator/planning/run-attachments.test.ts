import { describe, it, expect, afterEach } from 'vitest';
import { createPlannerBase } from '../../planners/base.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import {
  makeCallbacks,
  makeBusRecorder,
  TEST_METADATA,
} from '#testing/helpers/orchestrator-factories.js';
import { setupProject, REAL_TASKS_MD } from '#testing/helpers/planning-phase.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import type { Attachment } from '../../../core/schemas/attachment.js';
import type { PlannerCapabilities } from '../../planners/types.js';
import { runPlanningPhase } from './run.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';

const defaultCapabilities: PlannerCapabilities = {
  supportsConversationalPlanning: false,
  supportsHintEscalation: true,
  supportsSessionResume: false,
  supportsEffort: false,
  supportsImages: false,
  supportsSelfSummarisation: false,
};

function completedRunnerCall(text: string) {
  return makeRunnerCallResult({ status: 'completed', text });
}

describe('runPlanningPhase — attachments capability gate (F-123 seam)', () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) cleanupTempDir(d);
    dirs = [];
  });

  const attachment: Attachment = {
    id: 'att-1',
    kind: 'image',
    path: '/tmp/screenshot.png',
    mimeType: 'image/png',
    sizeBytes: 1024,
  };

  async function runQuickWithAttachment(supportsImages: boolean) {
    const { projectDir, sessionId } = setupProject(dirs);
    let seenImages: Attachment[] | undefined;
    const planner = createPlannerBase({
      invokePlan: async ({ images }) => {
        seenImages = images;
        return completedRunnerCall(REAL_TASKS_MD);
      },
      invokeEscalate: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities: { ...defaultCapabilities, supportsImages },
    });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const initial = transition(createInitialState('add a login form from this mockup'), {
      type: 'START',
    });
    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        config: makeConfig({ workflow: { mode: 'quick' } }),
        callbacks,
        metadata: TEST_METADATA,
        sessionId,
        bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
        drainPendingAttachments: () => [attachment],
      },
      planner,
      state: initial,
      feature: 'add a login form from this mockup',
    });
    return { result, events, getSeenImages: () => seenImages };
  }

  it('supportsImages false → emits planner_attachments_dropped and strips before the backend call', async () => {
    const { result, events, getSeenImages } = await runQuickWithAttachment(false);

    expect(result.disposition).toBe('ready-for-tasks');
    const dropped = events.find((e) => e.type === 'planner_attachments_dropped');
    expect(dropped).toBeDefined();
    expect(dropped && 'count' in dropped ? dropped.count : 0).toBe(1);
    expect(dropped && 'reason' in dropped ? dropped.reason : null).toBe('unsupported-backend');
    expect(getSeenImages()).toBeUndefined();
  });

  it('supportsImages true → forwards attachments verbatim to the backend, no drop event', async () => {
    const { result, events, getSeenImages } = await runQuickWithAttachment(true);

    expect(result.disposition).toBe('ready-for-tasks');
    expect(events.find((e) => e.type === 'planner_attachments_dropped')).toBeUndefined();
    expect(getSeenImages()).toEqual([attachment]);
  });
});
