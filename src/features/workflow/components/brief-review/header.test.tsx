import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { BRIEF_READINESS_FILE, TASKS_FILE } from '../../../../core/paths.js';
import { taskId } from '../../../../core/schemas/task.js';
import type { BriefReadinessGateReport } from '../../../../engine/orchestrator/planning/brief-readiness-gate.js';
import { PlanReviewHeader } from './header.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) cleanupTempDir(dir);
});

function blockingReport(ids: readonly string[]): BriefReadinessGateReport {
  return {
    ok: false,
    metadata: [],
    blocks: ids.map((id) => ({
      taskId: taskId(id),
      kind: 'overflow',
      message: `Task ${id} overflows the selected worker context`,
      nextAction: 'split the task or route it to a larger worker',
    })),
  };
}

function sessionDir(prefix: string): string {
  const dir = createTempDir(prefix);
  tmpDirs.push(dir);
  return dir;
}

describe('PlanReviewHeader', () => {
  it('renders the block count and the override instruction from the readiness prop', async () => {
    const dir = sessionDir('brief-header-prop');

    const ui = renderFeature(
      <PlanReviewHeader
        tasks={[makeTask()]}
        quality={null}
        readiness={blockingReport(['T001', 'T002'])}
        filePath={join(dir, TASKS_FILE)}
        width={100}
      />,
    );
    await flushEffects();
    const frame = stripAnsiStyles(ui.lastFrame());
    ui.unmount();

    expect(frame).toContain('readiness 2 blocked');
    expect(frame).toContain('approve again overrides');
  });

  it('claims no blocks when the prop carries no report, even with an artifact on disk', async () => {
    const dir = sessionDir('brief-header-stale');
    writeFileSync(
      join(dir, BRIEF_READINESS_FILE),
      JSON.stringify(blockingReport(['T001'])),
      'utf8',
    );

    const ui = renderFeature(
      <PlanReviewHeader
        tasks={[]}
        quality={null}
        readiness={null}
        filePath={join(dir, TASKS_FILE)}
        width={100}
        hasLoadError
      />,
    );
    // The wait is what makes the absence meaningful: a header that read the artifact itself
    // would have resolved that read and repainted well inside this window.
    await flushEffects();
    await tick(50);
    const frame = stripAnsiStyles(ui.lastFrame());
    ui.unmount();

    expect(frame).toContain('task briefs');
    expect(frame).not.toContain('blocked');
    expect(frame).not.toContain('approve again overrides');
  });

  it('claims no blocks when the report passes', async () => {
    const dir = sessionDir('brief-header-clear');

    const ui = renderFeature(
      <PlanReviewHeader
        tasks={[makeTask()]}
        quality={null}
        readiness={{ ok: true, metadata: [], blocks: [] }}
        filePath={join(dir, TASKS_FILE)}
        width={100}
      />,
    );
    await flushEffects();
    const frame = stripAnsiStyles(ui.lastFrame());
    ui.unmount();

    expect(frame).toContain('1 task');
    expect(frame).not.toContain('blocked');
    expect(frame).not.toContain('approve again overrides');
  });
});
