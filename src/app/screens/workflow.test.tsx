import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { readyReadiness } from '#testing/helpers/workflow-screen.js';
import type { Summary } from '../../core/schemas/summary.js';
import type { RunWorkflowOptions } from '../../engine/orchestrator/run/init.js';
import { getContentTopRow } from '../../features/workflow/layout/chrome-rows.js';
import { getWorkflowContentRect } from '../../features/workflow/layout/rect.js';
import { WorkflowScreen } from './workflow.js';

const runWorkflow = vi.fn<(opts: RunWorkflowOptions) => Promise<Summary>>();
const workflowDeps = { runWorkflow };

const { configStore } = await import('../../stores/project/config.js');
const { terminalSizeStore } = await import('../../stores/ui/terminal-size.js');
const { routerStore } = await import('../../stores/navigation/router.js');
const { inputHeightStore } = await import('../../stores/ui/input-height.js');

describe('WorkflowScreen chrome calibration', () => {
  let projectDir = '';

  beforeEach(() => {
    resetAllStores();
    projectDir = createTempDir('workflow-chrome-calibration');
    runWorkflow.mockReset();
    runWorkflow.mockReturnValue(new Promise<never>(() => {}));
  });

  afterEach(() => {
    resetAllStores();
    if (projectDir) cleanupTempDir(projectDir);
  });

  it('paints the body on the same row getWorkflowContentRect uses for pointer top', async () => {
    const cols = 120;
    const rows = 40;
    const inputRows = 2;
    configStore.__testReset({ config: makeConfig(), projectDir });
    terminalSizeStore.__testReset({ cols, rows, isSmall: false });
    inputHeightStore.__testReset({ rows: inputRows });
    routerStore.navigate({
      to: 'workflow',
      feature: 'chrome calibration',
      readiness: readyReadiness(projectDir),
    });

    const ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
    );
    await tick();

    const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
    const paintedBodyRow = lines.findIndex((line) => line.includes('no events yet'));
    expect(paintedBodyRow).toBeGreaterThanOrEqual(0);

    const contentRect = getWorkflowContentRect({
      cols,
      rows,
      inputRows,
      sidebarVisible: true,
      isSmall: false,
    });
    expect(contentRect.top).toBe(getContentTopRow());
    expect(paintedBodyRow + 1).toBe(contentRect.top);

    ui.unmount();
  });
});
