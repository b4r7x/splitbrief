import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import type { CollectedReadiness, CollectReadinessOptions } from '../../core/readiness/collect.js';
import type { ReadinessReport } from '../../core/readiness/types.js';
import type { Summary } from '../../core/schemas/summary.js';
import type { RunWorkflowOptions } from '../../engine/orchestrator/run/init.js';
import { WorkflowScreen } from './workflow.js';

const runWorkflow = vi.fn<(opts: RunWorkflowOptions) => Promise<Summary>>();
const collectReadiness = vi.fn<(options: CollectReadinessOptions) => Promise<CollectedReadiness>>();
const workflowDeps = { runWorkflow, collectReadiness };

const { configStore } = await import('../../stores/project/config.js');
const { terminalSizeStore } = await import('../../stores/ui/terminal-size.js');
const { routerStore } = await import('../../stores/navigation/router.js');
const { lifecycleStore } = await import('../../stores/workflow/lifecycle.js');
const { writeActive } = await import('../../core/sessions/lifecycle.js');
const { ensureDiptychDir, ensureSessionDir } = await import('../../core/paths-io.js');
const { READINESS_FILE, sessionDir } = await import('../../core/paths.js');

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
    // runWorkflow creates the session id lazily via writeActive + ensureSessionDir; emulate the
    // state of the filesystem once it has done so for a TUI-started run.
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
    collectReadiness.mockResolvedValue({ report: readyReadiness(projectDir), warnings: [] });
    configStore.__testReset({ config: makeConfig(), projectDir });
    terminalSizeStore.__testReset({ cols: 120, rows: 60, isSmall: false });
    // TUI home-composer start: feature present, no route readiness, no route session id.
    routerStore.navigate({ to: 'workflow', feature: 'tui readiness feature' });

    const target = join(sessionDir(projectDir, SESSION_ID), READINESS_FILE);
    const ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
    );

    // useReadinessFetch resolves client-side; nothing is written until the session run begins.
    await tick(20);
    expect(existsSync(target)).toBe(false);

    // runWorkflow has created the session and published workflow_started; the phase leaves idle.
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
    const { writeSecureFile } = await import('../../lib/fs.js');
    writeSecureFile(target, existing);

    collectReadiness.mockResolvedValue({ report: readyReadiness(projectDir), warnings: [] });
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
