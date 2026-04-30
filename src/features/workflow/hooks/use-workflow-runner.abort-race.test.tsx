import { Text } from 'ink';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { useWorkflowRunner } from './use-workflow-runner.js';
import type { UseInputModeResult } from './use-input-mode.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { resetWorkflow } from '../../../stores/workflow/actions.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { clearAllHandlers } from '../handlers.js';
import { runWorkflow } from '../../../engine/orchestrator/run/run.js';
import type { Summary } from '../../../core/schemas/summary.js';

vi.mock('../../../engine/orchestrator/run/run.js', () => ({
  WORKFLOW_REWIND_ABORT_REASON: 'workflow-rewind',
  runWorkflow: vi.fn(),
}));

const inputMode: UseInputModeResult = {
  mode: 'normal',
  hint: '',
  setReviewMode: async () => ({ approved: true }),
  setQuestionMode: async () => '',
  resolve: () => {},
  resetMode: () => {},
};

function Harness({ feature }: { feature: string }) {
  const runner = useWorkflowRunner({
    feature,
    projectDir: '/tmp/use-workflow-runner-abort-race',
    config: makeConfig(),
    onComplete: () => {},
    inputMode,
  });
  return <Text>{`${feature}:${runner.startedAt}`}</Text>;
}

describe('useWorkflowRunner abort race', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWorkflow();
    controlsStore.reset();
    feedbackStore.reset();
    clearAllHandlers();
  });

  it('does not publish an old aborted run error after a new run starts', async () => {
    const runWorkflowMock = vi.mocked(runWorkflow);
    let rejectFirst: ((reason: unknown) => void) | undefined;
    let firstSignal: AbortSignal | undefined;

    runWorkflowMock
      .mockImplementationOnce(({ signal }) => {
        firstSignal = signal;
        return new Promise<Summary>((_resolve, reject) => {
          rejectFirst = reject;
        });
      })
      .mockImplementationOnce(() => new Promise<Summary>(() => {}));

    const ui = renderFeature(<Harness feature="first run" />);
    await tick();

    expect(runWorkflowMock).toHaveBeenCalledTimes(1);

    ui.rerender(<Harness feature="second run" />);
    await tick();

    expect(firstSignal?.aborted).toBe(true);
    expect(runWorkflowMock).toHaveBeenCalledTimes(2);

    rejectFirst?.(new Error('old run rejected after abort'));
    await tick();

    expect(eventsStore.get().events.some(event => event.type === 'error')).toBe(false);
    ui.unmount();
  });
});
