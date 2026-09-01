import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { prepareWorkflowExecution } from '#testing/helpers/workflow-screen.js';
import type { Summary } from '../../../src/core/schemas/summary.js';
import type { RunWorkflowOptions } from '../../../src/engine/orchestrator/run/init.js';
import { READINESS_FILE, sessionDir } from '../../../src/core/paths.js';
import { WorkflowScreen } from '../../../src/app/screens/workflow.js';

const runWorkflow = vi.fn<(opts: RunWorkflowOptions) => Promise<Summary>>();
const workflowDeps = { runWorkflow };

const { configStore } = await import('../../../src/stores/project/config.js');
const { terminalSizeStore } = await import('../../../src/stores/ui/terminal-size.js');
const { routerStore } = await import('../../../src/stores/navigation/router.js');
const { lifecycleStore } = await import('../../../src/stores/workflow/lifecycle.js');

describe('WorkflowScreen prepared-route stability', () => {
  let projectDir = '';

  beforeEach(() => {
    resetAllStores();
    routerStore.navigate({ to: 'home' });
    runWorkflow.mockReset();
    runWorkflow.mockReturnValue(new Promise<never>(() => {}));
    projectDir = createTempDir('workflow-prepared-route');
  });

  afterEach(() => {
    resetAllStores();
    routerStore.navigate({ to: 'home' });
    cleanupTempDir(projectDir);
  });

  it('starts from the exact prepared authority without rechecking or rewriting readiness', async () => {
    const preparedConfig = makeConfig();
    const prepared = prepareWorkflowExecution({
      projectDir,
      feature: 'prepared route feature',
      config: preparedConfig,
      sessionId: 'prepared-route-session',
    });
    const target = join(sessionDir(projectDir, prepared.session.ref.sessionId), READINESS_FILE);
    const readinessBeforeMount = readFileSync(target, 'utf8');

    configStore.__testReset({
      config: makeConfig({ workflow: { mode: 'quick' } }),
      projectDir,
    });
    terminalSizeStore.__testReset({ cols: 120, rows: 60, isSmall: false });
    routerStore.navigate({
      to: 'workflow',
      execution: { kind: 'local', prepared },
    });

    const ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
    );

    await vi.waitFor(() => {
      expect(runWorkflow).toHaveBeenCalledTimes(1);
    });
    const call = runWorkflow.mock.calls[0];
    if (call === undefined) throw new Error('Expected workflow execution');
    expect(call[0].prepared).toBe(prepared);
    expect(ui.lastFrame() ?? '').not.toContain('Checking readiness');

    lifecycleStore.__testReset({ phase: 'researching', status: 'running' });
    await tick(20);
    expect(readFileSync(target, 'utf8')).toBe(readinessBeforeMount);

    ui.unmount();
  });
});
