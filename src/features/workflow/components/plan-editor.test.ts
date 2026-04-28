import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createElement } from 'react';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { TASKS_FILE } from '../../../core/paths.js';
import { formatTasks } from '../../../engine/spec/formatter.js';
import { planEditorStore } from '../../../stores/workflow/plan-editor.js';
import { configStore } from '../../../stores/project/config.js';
import { BriefReviewView } from './brief-review-view.js';
import { PlanEditorComponent } from './plan-editor.js';

let tmpDir: string;

const completeTask = (id: string, file: string) => makeTask({
  id,
  file,
  title: `Task ${id}`,
  action: 'modify',
  currentCode: 'export const value = 1;',
  constraints: ['Keep public API stable'],
  escalation: ['Stop if the file changed outside this task'],
  evidence: ['focused tests pass'],
  scope: { inBounds: [file], outOfBounds: ['unrelated files'] },
  typeDefs: 'type Value = number;',
});

beforeEach(async () => {
  planEditorStore.__testReset();
  configStore.__testReset();
  tmpDir = await mkdtemp(join(tmpdir(), 'plan-editor-component-test-'));
});

afterEach(async () => {
  planEditorStore.__testReset();
  configStore.__testReset();
  try { await rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function writeTasksFile() {
  const tasks = [
    completeTask('T001', 'src/a.ts'),
    completeTask('T002', 'src/b.ts'),
  ];
  await writeFile(join(tmpDir, TASKS_FILE), formatTasks(tasks), 'utf-8');
  return tasks;
}

describe('PlanEditorComponent review metadata', () => {
  it('renders worker, context fit, overflow, and conflict markers in task rows', async () => {
    await writeTasksFile();

    const ui = renderFeature(createElement(PlanEditorComponent, {
      filePath: join(tmpDir, TASKS_FILE),
      sessionDirPath: tmpDir,
      height: 24,
      width: 160,
    }));
    await tick(20);
    planEditorStore.setReviewMetadata([
      {
        taskId: 'T001',
        workerProfile: 'local-qwen',
        selectedCostTier: 'local',
        contextFit: 'fits',
        estimatedTokens: 1200,
        contextLength: 32768,
        risk: 'low',
      },
      {
        taskId: 'T002',
        workerProfile: 'cheap-cloud',
        selectedCostTier: 'cheap',
        contextFit: 'overflow',
        estimatedTokens: 18000,
        contextLength: 8192,
        risk: 'high',
        conflict: {
          kind: 'current-task-conflict',
          files: ['src/b.ts'],
          affectedTaskIds: ['T002'],
        },
      },
    ]);
    await tick();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('worker local-qwen');
    expect(frame).toContain('cost local');
    expect(frame).toContain('fit fits 1200/32768');
    expect(frame).toContain('worker cheap-cloud');
    expect(frame).toContain('cost cheap');
    expect(frame).toContain('fit overflow 18000/8192');
    expect(frame).toContain('conflict src/b.ts');
    expect(frame).toContain('context 1 fit');
    expect(frame).toContain('1 overflow');
    expect(frame).toContain('cost local:1,cheap:1');
  });

  it('shows selected task scope, constraints, tests, escalation, and checkpoint detail when expanded', async () => {
    await writeTasksFile();

    const ui = renderFeature(createElement(PlanEditorComponent, {
      filePath: join(tmpDir, TASKS_FILE),
      sessionDirPath: tmpDir,
      height: 40,
      width: 160,
    }));
    await tick(20);
    planEditorStore.setReviewMetadata([
      {
        taskId: 'T001',
        workerProfile: 'local-qwen',
        selectedCostTier: 'local',
        costPosture: 'Selected local cost tier via cheapest-capable routing',
        contextFit: 'tight',
        estimatedTokens: 7600,
        contextLength: 8192,
        routingReason: 'Selected cheapest capable profile local-qwen',
        checkpoint: 'pre-task T001',
      },
    ]);
    await tick();
    planEditorStore.toggleExpand('T001');
    await tick();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('scope bounds:');
    expect(frame).toContain('in src/a.ts');
    expect(frame).toContain('constraints:');
    expect(frame).toContain('Keep public API stable');
    expect(frame).toContain('tests:');
    expect(frame).toContain('returns the expected greeting');
    expect(frame).toContain('escalation:');
    expect(frame).toContain('Stop if the file changed outside this task');
    expect(frame).toContain('cost local');
    expect(frame).toContain('Selected local cost tier via cheapest-capable routing');
    expect(frame).toContain('checkpoint pre-task T001');
    expect(frame).toContain('Selected cheapest capable profile local-qwen');
  });

  it('keeps footer visible when task rows take multiple terminal lines', async () => {
    const tasks = [
      completeTask('T001', 'src/a.ts'),
      completeTask('T002', 'src/b.ts'),
      completeTask('T003', 'src/c.ts'),
      completeTask('T004', 'src/d.ts'),
      completeTask('T005', 'src/e.ts'),
    ];
    await writeFile(join(tmpDir, TASKS_FILE), formatTasks(tasks), 'utf-8');

    const ui = renderFeature(createElement(PlanEditorComponent, {
      filePath: join(tmpDir, TASKS_FILE),
      sessionDirPath: tmpDir,
      height: 16,
      width: 100,
    }));
    await tick(20);
    ui.stdin.write('j');
    ui.stdin.write('j');
    ui.stdin.write('j');
    await tick();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Y save');
    expect(frame).toContain('> ✓ T004');
    expect(frame).not.toContain('T001 pending src/a.ts');
  });

  it('shows conflict and stale markers in selected task detail', async () => {
    await writeTasksFile();

    const ui = renderFeature(createElement(PlanEditorComponent, {
      filePath: join(tmpDir, TASKS_FILE),
      sessionDirPath: tmpDir,
      height: 34,
      width: 100,
    }));
    await tick(20);
    planEditorStore.setReviewMetadata([
      {
        taskId: 'T001',
        workerProfile: 'cheap-cloud',
        selectedCostTier: 'cheap',
        costPosture: 'Selected cheap cost tier via cheapest-capable routing',
        contextFit: 'overflow',
        estimatedTokens: 18000,
        contextLength: 8192,
        validationStatus: 'fail',
        stale: true,
        conflict: {
          kind: 'future-task-stale-input',
          files: ['src/a.ts'],
          affectedTaskIds: ['T001'],
          note: 'User edited the file after review',
        },
      },
    ]);
    await tick();
    planEditorStore.toggleExpand('T001');
    await tick();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('worker cheap-cloud');
    expect(frame).toContain('cost cheap');
    expect(frame).toContain('Selected cheap cost tier via cheapest-capable routing');
    expect(frame).toContain('fit overflow 18000/8192');
    expect(frame).toContain('validation fail');
    expect(frame).toContain('future-task-stale-input: src/a.ts');
    expect(frame).toContain('stale input marker present');
  });

  it('renders warning symbols for conflict rows in simple review mode', async () => {
    await writeTasksFile();
    planEditorStore.setReviewMetadata([
      {
        taskId: 'T001',
        contextFit: 'overflow',
        conflict: {
          kind: 'current-task-conflict',
          files: ['src/a.ts'],
          affectedTaskIds: ['T001'],
        },
      },
    ]);

    const ui = renderFeature(createElement(BriefReviewView, {
      filePath: join(tmpDir, TASKS_FILE),
      height: 24,
      width: 100,
    }));
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('⚠ T001');
    expect(frame).toContain('fit overflow');
    expect(frame).toContain('conflict src/a.ts');
  });

  it('keeps the simple review footer visible on short terminal heights', async () => {
    const tasks = [
      completeTask('T001', 'src/a.ts'),
      completeTask('T002', 'src/b.ts'),
      completeTask('T003', 'src/c.ts'),
      completeTask('T004', 'src/d.ts'),
      completeTask('T005', 'src/e.ts'),
      completeTask('T006', 'src/f.ts'),
    ];
    await writeFile(join(tmpDir, TASKS_FILE), formatTasks(tasks), 'utf-8');

    const ui = renderFeature(createElement(BriefReviewView, {
      filePath: join(tmpDir, TASKS_FILE),
      height: 13,
      width: 100,
    }));
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('approve | e/edit');
    expect(frame).toContain('T001');
    expect(frame).toContain('+ 4 more tasks');
    expect(frame).not.toContain('T006 pending src/f.ts');
  });

  it('renders cost tier and posture from the routing preview', async () => {
    configStore.__testReset({
      config: {
        ...makeConfig(),
        implementerProfiles: {
          default: 'local-qwen',
          profiles: {
            'local-qwen': {
              kind: 'api',
              provider: 'ollama',
              apiBase: 'http://localhost:11434/v1',
              model: 'qwen2.5-coder:7b',
              contextLength: 32768,
              costTier: 'local',
            },
            frontier: {
              kind: 'api',
              provider: 'openrouter',
              apiBase: 'https://openrouter.ai/api/v1',
              apiKey: 'sk-or-test',
              model: 'anthropic/claude-sonnet',
              contextLength: 200000,
              costTier: 'frontier',
            },
          },
        },
      },
      projectDir: tmpDir,
    });
    await writeTasksFile();

    const ui = renderFeature(createElement(PlanEditorComponent, {
      filePath: join(tmpDir, TASKS_FILE),
      sessionDirPath: tmpDir,
      height: 34,
      width: 110,
    }));
    await tick(20);
    planEditorStore.toggleExpand('T001');
    await tick();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('worker local-qwen');
    expect(frame).toContain('cost local');
    expect(frame).toContain('cost local:2');
    expect(frame).toContain('Selected local cost tier via cheapest-capable routing');
  });

  it('keeps save and edit labels visible in a narrow layout', async () => {
    await writeTasksFile();

    const ui = renderFeature(createElement(PlanEditorComponent, {
      filePath: join(tmpDir, TASKS_FILE),
      sessionDirPath: tmpDir,
      height: 18,
      width: 48,
    }));
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('j/k nav');
    expect(frame).toContain('d del');
    expect(frame).toContain('s split');
    expect(frame).toContain('Y save');
  });
});
