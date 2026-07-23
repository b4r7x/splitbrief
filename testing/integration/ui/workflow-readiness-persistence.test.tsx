import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import type {
  CollectedReadiness,
  CollectReadinessOptions,
} from '../../../src/core/readiness/collect.js';
import type { ReadinessReport } from '../../../src/core/readiness/types.js';
import type { Summary } from '../../../src/core/schemas/summary.js';
import type { RunWorkflowOptions } from '../../../src/engine/orchestrator/run/init.js';
import { spinnerFrames } from '../../../src/lib/glyphs.js';
import { WorkflowScreen } from '../../../src/app/screens/workflow.js';

const runWorkflow = vi.fn<(opts: RunWorkflowOptions) => Promise<Summary>>();
const collectReadiness = vi.fn<(options: CollectReadinessOptions) => Promise<CollectedReadiness>>();
const workflowDeps = { runWorkflow, collectReadiness };

const { configStore } = await import('../../../src/stores/project/config.js');
const { terminalSizeStore } = await import('../../../src/stores/ui/terminal-size.js');
const { routerStore } = await import('../../../src/stores/navigation/router.js');
const { lifecycleStore } = await import('../../../src/stores/workflow/lifecycle.js');
const { writeActive } = await import('../../../src/core/sessions/lifecycle.js');
const { ensureDiptychDir, ensureSessionDir } = await import('../../../src/core/paths-io.js');
const { READINESS_FILE, sessionDir } = await import('../../../src/core/paths.js');

const SESSION_ID = '2026-06-14-tui-readiness';

function readyReadiness(projectDir: string): ReadinessReport {
  return {
    generatedAt: '2026-06-14T00:00:00.000Z',
    projectDir,
    status: 'ready',
    counts: { ok: 1, info: 0, warning: 0, blocker: 0 },
    nextAction: { kind: 'continue', label: 'Continue', reason: 'ready' },
    sections: [],
    metadata: {},
  };
}

describe('WorkflowScreen TUI readiness persistence', () => {
  let projectDir: string;

  beforeEach(() => {
    resetAllStores();
    routerStore.navigate({ to: 'home' });
    runWorkflow.mockReset();
    runWorkflow.mockReturnValue(new Promise<never>(() => {}));
    collectReadiness.mockReset();
    projectDir = createTempDir('workflow-readiness-persist');
    ensureDiptychDir(projectDir);
    ensureSessionDir(projectDir, SESSION_ID);
    writeActive({ projectDir, sessionId: SESSION_ID });
  });

  afterEach(() => {
    resetAllStores();
    routerStore.navigate({ to: 'home' });
    cleanupTempDir(projectDir);
  });

  it('persists the client-computed readiness report to readiness.json once the run starts', async () => {
    let resolveCollect!: (value: CollectedReadiness) => void;
    const pendingCollect = new Promise<CollectedReadiness>((resolve) => {
      resolveCollect = resolve;
    });
    collectReadiness.mockReturnValue(pendingCollect);
    configStore.__testReset({ config: makeConfig(), projectDir });
    terminalSizeStore.__testReset({ cols: 120, rows: 60, isSmall: false });
    routerStore.navigate({ to: 'workflow', feature: 'tui readiness feature' });

    const target = join(sessionDir(projectDir, SESSION_ID), READINESS_FILE);
    const ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
    );

    await tick(1);
    const checkingFrame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(checkingFrame).toContain('Checking readiness…');
    const spinnerChar = spinnerFrames().find((frame) => checkingFrame.includes(frame));
    expect(spinnerChar).toBeDefined();

    resolveCollect({ report: readyReadiness(projectDir) });
    await tick(20);
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).not.toContain('Checking readiness…');

    expect(existsSync(target)).toBe(false);

    lifecycleStore.__testReset({ phase: 'researching' });
    await tick(20);

    expect(existsSync(target)).toBe(true);
    const record = JSON.parse(readFileSync(target, 'utf-8'));
    expect(record).toMatchObject({
      type: 'start-readiness',
      status: 'ready',
      nextAction: 'continue',
      blockerCount: 0,
      warningCount: 0,
      checks: [],
    });

    ui.unmount();
  });

  it('does not overwrite an existing readiness.json (CLI-started sessions)', async () => {
    const existing = '{"type":"start-readiness","sentinel":true}\n';
    const target = join(sessionDir(projectDir, SESSION_ID), READINESS_FILE);
    const { writeSecureFile } = await import('../../../src/lib/fs.js');
    writeSecureFile(target, existing);

    collectReadiness.mockResolvedValue({ report: readyReadiness(projectDir) });
    configStore.__testReset({ config: makeConfig(), projectDir });
    terminalSizeStore.__testReset({ cols: 120, rows: 60, isSmall: false });
    routerStore.navigate({ to: 'workflow', feature: 'tui readiness feature' });

    const ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
    );
    await tick(20);
    lifecycleStore.__testReset({ phase: 'researching' });
    await tick(20);

    expect(readFileSync(target, 'utf-8')).toBe(existing);

    ui.unmount();
  });
});
