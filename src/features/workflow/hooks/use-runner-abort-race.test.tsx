import { Text } from 'ink';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { useInputMode } from './use-input-mode.js';
import { useWorkflowRunner } from './use-runner.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { resetWorkflow } from '../../../stores/workflow/actions.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { clearAllHandlers } from '../handlers.js';
import { ensureDiptychDir } from '../../../core/paths-io.js';

function Harness({
  feature,
  projectDir,
  plannerCommand,
}: {
  feature: string;
  projectDir: string;
  plannerCommand: string;
}) {
  const inputMode = useInputMode();
  const config = makeConfig({
    planner: { kind: 'shell', command: plannerCommand },
  });
  const runner = useWorkflowRunner({
    feature,
    projectDir,
    config,
    onComplete: () => {},
    inputMode,
  });
  return <Text>{`${feature}:${runner.startedAt}`}</Text>;
}

async function flush(ms = 120) {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

let projectDir: string;

describe('useWorkflowRunner abort race', () => {
  beforeEach(() => {
    projectDir = createTempDir('workflow-abort-race-test');
    createTestGitRepo(projectDir);
    ensureDiptychDir(projectDir);
    resetWorkflow();
    controlsStore.reset();
    feedbackStore.reset();
    clearAllHandlers();
  });

  afterEach(() => {
    clearAllHandlers();
    resetWorkflow();
    controlsStore.reset();
    feedbackStore.reset();
    cleanupTempDir(projectDir);
  });

  it('rerender with a new feature aborts the pending first run without leaking its error', async () => {
    const ui = render(
      <Harness feature="first run" projectDir={projectDir} plannerCommand="sleep 10" />,
    );
    await flush();

    ui.rerender(
      <Harness
        feature="second run"
        projectDir={projectDir}
        plannerCommand="diptych-non-existent-planner-x7q9"
      />,
    );
    await flush();

    const errors = eventsStore.get().events.filter((e) => e.type === 'error');
    const hasSleepKilledError = errors.some(
      (e) => e.message.includes('sleep') || e.message.includes('SIGTERM'),
    );
    expect(hasSleepKilledError).toBe(false);
    ui.unmount();
  });
});
