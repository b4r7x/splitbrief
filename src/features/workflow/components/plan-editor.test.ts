import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { overlayStore } from '../../../stores/ui/overlay.js';
import { BriefReviewView } from './brief-review-view.js';
import { PlanEditorComponent } from './plan-editor.js';
import { PlanEditorHelpOverlay } from './plan-editor/help-overlay.js';

let tmpDir: string;
const rendered: Array<{ unmount: () => void }> = [];

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
  overlayStore.reset();
  tmpDir = await mkdtemp(join(tmpdir(), 'plan-editor-component-test-'));
});

afterEach(async () => {
  while (rendered.length > 0) {
    try { rendered.pop()?.unmount(); } catch { /* ignore */ }
  }
  planEditorStore.__testReset();
  configStore.__testReset();
  overlayStore.reset();
  try { await rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function renderComponent(element: Parameters<typeof renderFeature>[0]) {
  const ui = renderFeature(element);
  rendered.push(ui);
  return ui;
}

async function writeTasksFile() {
  const tasks = [
    completeTask('T001', 'src/a.ts'),
    completeTask('T002', 'src/b.ts'),
  ];
  await writeFile(join(tmpDir, TASKS_FILE), formatTasks(tasks), 'utf-8');
  return tasks;
}

describe('PlanEditorComponent review metadata', () => {
  it('surfaces tasks.md read failures in the rich editor instead of loading an empty plan', async () => {
    const missingPath = join(tmpDir, TASKS_FILE);

    const ui = renderComponent(createElement(PlanEditorComponent, {
      filePath: missingPath,
      sessionDirPath: tmpDir,
      height: 24,
      width: 120,
    }));
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Failed to load Task Briefs');
    expect(planEditorStore.get().tasks).toEqual([]);

    ui.stdin.write('Y');
    await tick(20);

    await expect(readFile(missingPath, 'utf-8')).rejects.toThrow();
  });

  it('surfaces tasks.md read failures in simple review mode instead of loading an empty plan', async () => {
    const missingPath = join(tmpDir, TASKS_FILE);

    const ui = renderComponent(createElement(BriefReviewView, {
      filePath: missingPath,
      height: 24,
      width: 120,
    }));
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Failed to load Task Briefs');
  });

  it('ignores invalid brief-quality.json instead of trusting its shape', async () => {
    await writeTasksFile();
    await writeFile(join(tmpDir, 'brief-quality.json'), JSON.stringify({
      version: 1,
      passed: true,
      score: '1.00',
      issues: [],
    }), 'utf-8');

    const ui = renderComponent(createElement(PlanEditorComponent, {
      filePath: join(tmpDir, TASKS_FILE),
      sessionDirPath: tmpDir,
      height: 24,
      width: 120,
    }));
    await tick(20);

    expect(ui.lastFrame() ?? '').toContain('quality n/a');
  });

  it('renders the plan review scorecard in the rich editor', async () => {
    const tasks = [
      completeTask('T001', 'src/a.ts'),
      makeTask({
        id: 'T002',
        file: 'src/b.ts',
        title: 'Task T002',
        action: 'modify',
        currentCode: 'export const value = 2;',
        tests: [],
        evidence: [],
        scope: { inBounds: ['src/b.ts'], outOfBounds: [] },
      }),
      completeTask('T003', 'src/c.ts'),
    ];
    await writeFile(join(tmpDir, TASKS_FILE), formatTasks(tasks), 'utf-8');

    const ui = renderComponent(createElement(PlanEditorComponent, {
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
        estimateStatus: 'refreshed-current-code',
        validationStatus: 'pass',
        risk: 'low',
      },
      {
        taskId: 'T002',
        contextFit: 'overflow',
        estimatedTokens: 42000,
        contextLength: 8192,
        estimateStatus: 'refreshed-current-code',
        validationStatus: 'fail',
        risk: 'high',
        routingReason: 'Task overflows every capable profile',
      },
    ]);
    await tick();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('ready 1');
    expect(frame).toContain('routing pending 1');
    expect(frame).toContain('split/overflow 1');
    expect(frame).toContain('risky/tight 1');
    expect(frame).toContain('stale/conflict 0');
    expect(frame).toContain('missing checks 1');
  });

  it('renders the plan review scorecard in simple review mode', async () => {
    const tasks = [
      completeTask('T001', 'src/a.ts'),
      makeTask({
        id: 'T002',
        file: 'src/b.ts',
        title: 'Task T002',
        action: 'modify',
        currentCode: 'export const value = 2;',
        tests: [],
        evidence: [],
        scope: { inBounds: ['src/b.ts'], outOfBounds: [] },
      }),
      completeTask('T003', 'src/c.ts'),
    ];
    await writeFile(join(tmpDir, TASKS_FILE), formatTasks(tasks), 'utf-8');
    planEditorStore.setReviewMetadata([
      {
        taskId: 'T001',
        workerProfile: 'local-qwen',
        selectedCostTier: 'local',
        contextFit: 'fits',
        estimatedTokens: 1200,
        contextLength: 32768,
        estimateStatus: 'refreshed-current-code',
        validationStatus: 'pass',
        risk: 'low',
      },
      {
        taskId: 'T002',
        contextFit: 'overflow',
        estimatedTokens: 42000,
        contextLength: 8192,
        estimateStatus: 'refreshed-current-code',
        validationStatus: 'fail',
        risk: 'high',
        routingReason: 'Task overflows every capable profile',
      },
    ]);

    const ui = renderComponent(createElement(BriefReviewView, {
      filePath: join(tmpDir, TASKS_FILE),
      height: 24,
      width: 160,
    }));
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('ready 1');
    expect(frame).toContain('routing pending 1');
    expect(frame).toContain('split/overflow 1');
    expect(frame).toContain('risky/tight 1');
    expect(frame).toContain('stale/conflict 0');
    expect(frame).toContain('missing checks 1');
  });

  it('renders worker, context fit, overflow, and conflict markers in task rows', async () => {
    await writeTasksFile();

    const ui = renderComponent(createElement(PlanEditorComponent, {
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

    const ui = renderComponent(createElement(PlanEditorComponent, {
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

    const ui = renderComponent(createElement(PlanEditorComponent, {
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
    expect(frame).toContain('Y approve');
    expect(frame).toContain('> ✓ T004');
    expect(frame).not.toContain('T001 pending src/a.ts');
  });

  it('shows conflict and stale markers in selected task detail', async () => {
    await writeTasksFile();

    const ui = renderComponent(createElement(PlanEditorComponent, {
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

    const ui = renderComponent(createElement(BriefReviewView, {
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

    const ui = renderComponent(createElement(BriefReviewView, {
      filePath: join(tmpDir, TASKS_FILE),
      height: 13,
      width: 100,
    }));
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('approve | e/edit');
    expect(frame).toContain('T001');
    expect(frame).toContain('+ 5 more tasks');
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

    const ui = renderComponent(createElement(PlanEditorComponent, {
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

  it('toggles selected-task worker packet preview with p', async () => {
    await writeTasksFile();

    const ui = renderComponent(createElement(PlanEditorComponent, {
      filePath: join(tmpDir, TASKS_FILE),
      sessionDirPath: tmpDir,
      height: 30,
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
        estimateStatus: 'refreshed-current-code',
        validationStatus: 'pass',
      },
    ]);
    await tick();

    ui.stdin.write('p');
    await tick();

    let frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Packet Preview T001');
    expect(frame).toContain('worker local-qwen');
    expect(frame).toContain('cost local');
    expect(frame).toContain('fit fits');
    expect(frame).toContain('tokens 1200');
    expect(frame).toContain('context 32768');
    expect(frame).toContain('current-code');
    expect(frame).toContain('estimate refreshed-current-code');
    expect(frame).toContain('system SYSTEM: You are a TypeScript code generator');
    expect(frame).toContain('task ## Project: unknown');
    expect(frame).toContain('## Task: Task T001');

    ui.stdin.write('p');
    await tick();

    frame = ui.lastFrame() ?? '';
    expect(frame).not.toContain('Packet Preview T001');
  });

  it('renders packet preview with current code refreshed from disk instead of stale Task Brief currentCode', async () => {
    const task = makeTask({
      id: 'T001',
      file: 'src/target.ts',
      title: 'Refresh target',
      action: 'modify',
      currentCode: 'export const staleBriefValue = "stale";',
      implementationSteps: [],
      typeDefs: '',
    });
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await writeFile(join(tmpDir, TASKS_FILE), formatTasks([task]), 'utf-8');
    await writeFile(join(tmpDir, 'src/target.ts'), 'export const freshDiskValue = "fresh";', 'utf-8');

    const ui = renderComponent(createElement(PlanEditorComponent, {
      filePath: join(tmpDir, TASKS_FILE),
      sessionDirPath: tmpDir,
      height: 30,
      width: 1000,
    }));
    await tick(20);

    ui.stdin.write('p');
    await tick(50);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Packet Preview T001');
    expect(frame).toContain('freshDiskValue');
    expect(frame).not.toContain('staleBriefValue');
    expect(frame).toContain('current-code whole-file');
    expect(frame).toContain('estimate refreshed-current-code');
    expect(planEditorStore.get().dirty).toBe(false);
    expect(await readFile(join(tmpDir, TASKS_FILE), 'utf-8')).toContain('staleBriefValue');
  });

  it('omits stale Task Brief currentCode and shows a missing-current-code signal when the target file is missing', async () => {
    const task = makeTask({
      id: 'T001',
      file: 'src/missing.ts',
      title: 'Refresh missing target',
      action: 'modify',
      currentCode: 'export const staleMissingValue = "stale";',
      implementationSteps: [],
      typeDefs: '',
    });
    await writeFile(join(tmpDir, TASKS_FILE), formatTasks([task]), 'utf-8');

    const ui = renderComponent(createElement(PlanEditorComponent, {
      filePath: join(tmpDir, TASKS_FILE),
      sessionDirPath: tmpDir,
      height: 30,
      width: 1000,
    }));
    await tick(20);

    ui.stdin.write('p');
    await tick(50);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Packet Preview T001');
    expect(frame).not.toContain('staleMissingValue');
    expect(frame).toContain('current-code none');
    expect(frame).toContain('estimate missing-current-code');
    expect(frame).toContain('refresh required');
    expect(planEditorStore.get().dirty).toBe(false);
  });

  it('lists the packet preview key in the plan editor help overlay', async () => {
    overlayStore.open('plan-editor-help');

    const ui = renderComponent(createElement(PlanEditorHelpOverlay));
    await tick();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('p');
    expect(frame).toContain('Toggle worker packet preview');
  });

  it('updates packet preview when cursor moves', async () => {
    await writeTasksFile();

    const ui = renderComponent(createElement(PlanEditorComponent, {
      filePath: join(tmpDir, TASKS_FILE),
      sessionDirPath: tmpDir,
      height: 30,
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
      },
      {
        taskId: 'T002',
        workerProfile: 'cheap-cloud',
        selectedCostTier: 'cheap',
        contextFit: 'tight',
        estimatedTokens: 7600,
        contextLength: 8192,
      },
    ]);
    await tick();

    ui.stdin.write('p');
    await tick();
    expect(ui.lastFrame() ?? '').toContain('Packet Preview T001');

    ui.stdin.write('j');
    await tick();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Packet Preview T002');
    expect(frame).toContain('worker cheap-cloud');
    expect(frame).toContain('cost cheap');
    expect(frame).toContain('## Task: Task T002');
  });

  it('collapses packet preview and keeps footer visible in short layouts', async () => {
    await writeTasksFile();

    const ui = renderComponent(createElement(PlanEditorComponent, {
      filePath: join(tmpDir, TASKS_FILE),
      sessionDirPath: tmpDir,
      height: 16,
      width: 80,
    }));
    await tick(20);

    ui.stdin.write('p');
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('packet preview collapsed');
    expect(frame).toContain('j/k navigate');
    expect(frame).toContain('Y approve');
  });

  it('shows both system and task excerpts when packet preview is expanded at medium height', async () => {
    await writeTasksFile();

    const ui = renderComponent(createElement(PlanEditorComponent, {
      filePath: join(tmpDir, TASKS_FILE),
      sessionDirPath: tmpDir,
      height: 20,
      width: 120,
    }));
    await tick(20);

    ui.stdin.write('p');
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Packet Preview T001');
    expect(frame).toContain('system SYSTEM: You are a TypeScript code generator');
    expect(frame).toContain('task ## Project: unknown');
    expect(frame).toContain('Y approve');
  });

  it('keeps save and edit labels visible in a narrow layout', async () => {
    await writeTasksFile();

    const ui = renderComponent(createElement(PlanEditorComponent, {
      filePath: join(tmpDir, TASKS_FILE),
      sessionDirPath: tmpDir,
      height: 18,
      width: 48,
    }));
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Y app');
    expect(frame).toContain('q dis');
  });

  it('keeps simple review scorecard to one reserved row in a narrow layout', async () => {
    const tasks = [
      completeTask('T001', 'src/a.ts'),
      completeTask('T002', 'src/b.ts'),
      completeTask('T003', 'src/c.ts'),
    ];
    await writeFile(join(tmpDir, TASKS_FILE), formatTasks(tasks), 'utf-8');

    const ui = renderComponent(createElement(BriefReviewView, {
      filePath: join(tmpDir, TASKS_FILE),
      height: 13,
      width: 48,
    }));
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('ready 0');
    expect(frame).toContain('approve | e/edit');
    expect(frame).toContain('T001');
    expect(frame).toContain('+ 2 more tasks');
  });
});
