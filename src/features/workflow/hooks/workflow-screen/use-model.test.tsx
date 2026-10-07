import { useEffect } from 'react';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { Text } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { prepareWorkflowExecution } from '#testing/helpers/workflow-screen.js';
import { routerStore } from '../../../../stores/navigation/router.js';
import { feedbackStore } from '../../../../stores/ui/feedback.js';
import { stopStore } from '../../../../stores/workflow/stop.js';
import { clearAllHandlers } from '../../handlers.js';
import { useWorkflowScreen } from './use-model.js';

type Model = ReturnType<typeof useWorkflowScreen>;

function Harness({ capture }: { capture: { current: Model | null } }) {
  const model = useWorkflowScreen({
    onRuntimeCommand: () => {},
    deps: { runWorkflow: () => new Promise(() => {}) },
  });
  useEffect(() => {
    capture.current = model;
  });
  return <Text>ready</Text>;
}

function requireModel(capture: { current: Model | null }): Model {
  if (capture.current === null) throw new Error('expected the workflow screen model');
  return capture.current;
}

describe('useWorkflowScreen while a brief is parked', () => {
  let projectDir = '';

  beforeEach(() => {
    resetAllStores();
    clearAllHandlers();
    projectDir = createTempDir('use-model-parked');
    routerStore.navigate({
      to: 'workflow',
      run: makeRunRecord(),
      execution: {
        kind: 'local',
        prepared: prepareWorkflowExecution({
          projectDir,
          feature: 'parked feature',
          config: makeConfig(),
          sessionId: 'use-model-session',
        }),
      },
    });
  });

  afterEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
    cleanupTempDir(projectDir);
    projectDir = '';
  });

  it.each([
    ['mid-brief', 'stop-now'],
    ['boundary', 'pause-after-brief'],
  ] as const)('blank enter at a %s park resumes the run like /resume', async (kind, intent) => {
    const capture: { current: Model | null } = { current: null };
    const ui = renderFeature(<Harness capture={capture} />);
    await tick();

    const steer = vi.fn();
    stopStore.request(intent);
    stopStore.park(kind, 'T004', steer);
    await tick();

    requireModel(capture).onEmptySubmit?.();

    expect(steer).toHaveBeenCalledWith('');
    expect(stopStore.get().phase).toBe('idle');
    expect(feedbackStore.get().isError).toBe(false);
    ui.unmount();
  });

  it('typed instructions steer the parked brief and resume it', async () => {
    const capture: { current: Model | null } = { current: null };
    const ui = renderFeature(<Harness capture={capture} />);
    await tick();

    const steer = vi.fn();
    stopStore.request('stop-now');
    stopStore.park('mid-brief', 'T002', steer);
    await tick();

    requireModel(capture).handleInput('use the other adapter');

    expect(steer).toHaveBeenCalledWith('use the other adapter');
    expect(stopStore.get().phase).toBe('idle');
    ui.unmount();
  });
});
