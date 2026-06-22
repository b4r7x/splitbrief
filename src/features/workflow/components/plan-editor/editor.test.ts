import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createElement } from 'react';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { TASKS_FILE } from '../../../../core/paths.js';
import { taskId } from '../../../../core/schemas/task.js';
import { formatTasks } from '../../../../engine/spec/formatter.js';
import { planEditorStore } from '../../../../stores/workflow/plan-editor.js';
import { configStore } from '../../../../stores/project/config.js';
import { overlayStore } from '../../../../stores/ui/overlay.js';
import { BriefReviewView } from '../brief-review-view.js';
import { createSaveHandler } from '../../plan-editor/save.js';
import { PlanEditorComponent } from './editor.js';
import { PlanEditorHelpOverlay } from './help-overlay.js';

let tmpDir: string;
const rendered: Array<{ unmount: () => void }> = [];

const completeTask = (id: string, file: string) =>
  makeTask({
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
    try {
      rendered.pop()?.unmount();
    } catch {
      /* ignore */
    }
  }
  planEditorStore.__testReset();
  configStore.__testReset();
  overlayStore.reset();
  try {
    await rm(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function renderComponent(element: Parameters<typeof renderFeature>[0]) {
  const ui = renderFeature(element);
  rendered.push(ui);
  return ui;
}

async function writeTasksFile() {
  const tasks = [completeTask('T001', 'src/a.ts'), completeTask('T002', 'src/b.ts')];
  await writeFile(join(tmpDir, TASKS_FILE), formatTasks(tasks), 'utf-8');
  return tasks;
}

describe('PlanEditorComponent review metadata', () => {
  it('surfaces tasks.md read failures in the rich editor instead of loading an empty plan', async () => {
    const missingPath = join(tmpDir, TASKS_FILE);
    const staleTask = completeTask('T999', 'src/stale.ts');
    planEditorStore.__testReset({
      tasks: [staleTask],
      savedTasks: [staleTask],
      cursor: 3,
      dirty: true,
      expandedIds: new Set(['T999']),
      flaggedIds: new Set(['T999']),
      reviewMetadata: new Map([
        [
          'T999',
          {
            taskId: taskId('T999'),
            workerProfile: 'stale-worker',
          },
        ],
      ]),
    });

    const ui = renderComponent(
      createElement(PlanEditorComponent, {
        filePath: missingPath,
        sessionDirPath: tmpDir,
        height: 24,
        width: 120,
      }),
    );

    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain('Failed to load Task Briefs');
    });
    expect(planEditorStore.get().tasks).toEqual([]);
    expect(planEditorStore.get().flaggedIds.size).toBe(0);
    expect(planEditorStore.get().reviewMetadata.size).toBe(0);
    expect(planEditorStore.get().dirty).toBe(false);
    expect(ui.lastFrame() ?? '').not.toContain('T999');
    expect(ui.lastFrame() ?? '').toContain('N reject');

    ui.stdin.write('Y');
    await tick(20);

    await expect(readFile(missingPath, 'utf-8')).rejects.toThrow();
  });

  it('surfaces tasks.md read failures in simple review mode instead of loading an empty plan', async () => {
    const missingPath = join(tmpDir, TASKS_FILE);

    const ui = renderComponent(
      createElement(BriefReviewView, {
        filePath: missingPath,
        height: 24,
        width: 120,
      }),
    );
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain('Failed to load Task Briefs');
    });

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Failed to load Task Briefs');
  });

  it('ignores invalid brief-quality.json instead of trusting its shape', async () => {
    await writeTasksFile();
    await writeFile(
      join(tmpDir, 'brief-quality.json'),
      JSON.stringify({
        version: 1,
        passed: true,
        score: '1.00',
        issues: [],
      }),
      'utf-8',
    );

    const ui = renderComponent(
      createElement(PlanEditorComponent, {
        filePath: join(tmpDir, TASKS_FILE),
        sessionDirPath: tmpDir,
        height: 24,
        width: 120,
      }),
    );
    await tick(20);

    expect(ui.lastFrame() ?? '').toContain('quality n/a');
  });

  it('renders inline section edits and saves them through the existing validation path', async () => {
    const projectDir = join(tmpDir, 'project');
    const sessionDir = join(projectDir, '.diptych', 'sessions', 'inline-edit-session');
    await mkdir(sessionDir, { recursive: true });
    const tasks = [completeTask('T001', 'src/a.ts'), completeTask('T002', 'src/b.ts')];
    await writeFile(join(sessionDir, TASKS_FILE), formatTasks(tasks), 'utf-8');
    const ui = renderComponent(
      createElement(PlanEditorComponent, {
        filePath: join(sessionDir, TASKS_FILE),
        sessionDirPath: sessionDir,
        height: 30,
        width: 120,
      }),
    );

    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain('Task T001');
    });

    planEditorStore.toggleExpand('T001');
    planEditorStore.enterSectionList();
    planEditorStore.moveSectionCursor('down');
    planEditorStore.startEditingSection();
    planEditorStore.updateEditingValue(
      'Create a hello world module with inline description updates',
    );
    planEditorStore.saveEditingSection();
    await tick(20);

    expect(ui.lastFrame() ?? '').toContain('inline description updates');

    await createSaveHandler(sessionDir)();
    await vi.waitFor(async () => {
      expect(await readFile(join(sessionDir, TASKS_FILE), 'utf-8')).toContain(
        'Create a hello world module with inline description updates',
      );
    });
  });

  it('saves dirty edits before submitting targeted regeneration', async () => {
    const projectDir = join(tmpDir, 'regen-project');
    const sessionDir = join(projectDir, '.diptych', 'sessions', 'regen-session');
    await mkdir(sessionDir, { recursive: true });
    const tasks = [completeTask('T001', 'src/a.ts'), completeTask('T002', 'src/b.ts')];
    await writeFile(join(sessionDir, TASKS_FILE), formatTasks(tasks), 'utf-8');
    let persistedAtRegeneration = '';
    const onRegenerateFlagged = vi.fn(async () => {
      persistedAtRegeneration = await readFile(join(sessionDir, TASKS_FILE), 'utf-8');
    });
    const ui = renderComponent(
      createElement(PlanEditorComponent, {
        filePath: join(sessionDir, TASKS_FILE),
        sessionDirPath: sessionDir,
        height: 30,
        width: 120,
        onRegenerateFlagged,
      }),
    );

    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain('Task T001');
    });

    const firstTask = tasks[0];
    const secondTask = tasks[1];
    if (!firstTask || !secondTask) throw new Error('expected two tasks');
    planEditorStore.setTasks([{ ...firstTask, title: 'Edited baseline task' }, secondTask]);
    planEditorStore.toggleFlag('T001');
    await tick();
    ui.stdin.write('R');
    await tick();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(onRegenerateFlagged).toHaveBeenCalledTimes(1);
    });
    expect(persistedAtRegeneration).toContain('Edited baseline task');
    expect(planEditorStore.get().dirty).toBe(false);
  });

  it('exposes an explicit rich reject action separate from discard', async () => {
    await writeTasksFile();
    const onReject = vi.fn();
    const ui = renderComponent(
      createElement(PlanEditorComponent, {
        filePath: join(tmpDir, TASKS_FILE),
        sessionDirPath: tmpDir,
        height: 24,
        width: 120,
        onReject,
      }),
    );
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain('N reject');
    });

    ui.stdin.write('N');
    await tick();

    expect(onReject).toHaveBeenCalledTimes(1);
    expect(planEditorStore.get().runtimeRichMode).toBe(false);
  });

  it('shows Evidence in expanded task details', async () => {
    await writeTasksFile();
    const ui = renderComponent(
      createElement(PlanEditorComponent, {
        filePath: join(tmpDir, TASKS_FILE),
        sessionDirPath: tmpDir,
        height: 24,
        width: 120,
      }),
    );

    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain('Task T001');
    });

    planEditorStore.toggleExpand('T001');
    await tick();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('evidence:');
    expect(frame).toContain('focused tests pass');
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

    const ui = renderComponent(
      createElement(PlanEditorComponent, {
        filePath: join(tmpDir, TASKS_FILE),
        sessionDirPath: tmpDir,
        height: 24,
        width: 160,
      }),
    );
    await tick(20);
    planEditorStore.setReviewMetadata([
      {
        taskId: taskId('T001'),
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
        taskId: taskId('T002'),
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
        taskId: taskId('T001'),
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
        taskId: taskId('T002'),
        contextFit: 'overflow',
        estimatedTokens: 42000,
        contextLength: 8192,
        estimateStatus: 'refreshed-current-code',
        validationStatus: 'fail',
        risk: 'high',
        routingReason: 'Task overflows every capable profile',
      },
    ]);

    const ui = renderComponent(
      createElement(BriefReviewView, {
        filePath: join(tmpDir, TASKS_FILE),
        height: 24,
        width: 160,
      }),
    );
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain('ready 1');
    });

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

    const ui = renderComponent(
      createElement(PlanEditorComponent, {
        filePath: join(tmpDir, TASKS_FILE),
        sessionDirPath: tmpDir,
        height: 24,
        width: 160,
      }),
    );
    await tick(20);
    planEditorStore.setReviewMetadata([
      {
        taskId: taskId('T001'),
        workerProfile: 'local-qwen',
        selectedCostTier: 'local',
        contextFit: 'fits',
        estimatedTokens: 1200,
        contextLength: 32768,
        risk: 'low',
      },
      {
        taskId: taskId('T002'),
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

    const ui = renderComponent(
      createElement(PlanEditorComponent, {
        filePath: join(tmpDir, TASKS_FILE),
        sessionDirPath: tmpDir,
        height: 40,
        width: 160,
      }),
    );
    await tick(20);
    planEditorStore.setReviewMetadata([
      {
        taskId: taskId('T001'),
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

  it('sanitizes task fields in rich rows, expanded details, and section previews', async () => {
    const rawToken = 'abcdefghijklmnopqrstuvwxyz1234567890abcdef';
    await writeFile(
      join(tmpDir, TASKS_FILE),
      formatTasks([
        makeTask({
          id: 'T001',
          file: 'src/\u001b]52;c;clipboard\u0007target.ts',
          title: `Do token=${rawToken}`,
          description: `Describe \u001b[31mtoken=${rawToken}\u001b[0m`,
          implementationSteps: [`Run tests \u001b]52;c;clipboard\u0007token=${rawToken}`],
          constraints: [`Keep token=${rawToken} hidden`],
          tests: [`npm test token=${rawToken}`],
          evidence: [`evidence token=${rawToken}`],
          escalation: [`escalate token=${rawToken}`],
          scope: {
            inBounds: ['src/\u001b]52;c;clipboard\u0007target.ts'],
            outOfBounds: [`token=${rawToken}`],
          },
          typeDefs: '',
        }),
      ]),
      'utf-8',
    );

    const ui = renderComponent(
      createElement(PlanEditorComponent, {
        filePath: join(tmpDir, TASKS_FILE),
        sessionDirPath: tmpDir,
        height: 46,
        width: 160,
      }),
    );
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain('Do token=***REDACTED***');
    });

    planEditorStore.setReviewMetadata([
      {
        taskId: taskId('T001'),
        workerProfile: `token=${rawToken}`,
        selectedCostTier: 'local',
        contextFit: 'fits',
        routingReason: `route token=${rawToken}`,
        conflict: {
          kind: 'current-task-conflict',
          files: ['src/\u001b]52;c;clipboard\u0007target.ts'],
          affectedTaskIds: ['T001'],
          note: `note token=${rawToken}`,
        },
      },
    ]);
    await tick();
    planEditorStore.toggleExpand('T001');
    planEditorStore.enterSectionList();
    await tick();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('src/target.ts');
    expect(frame).toContain('Describe token=***REDACTED***');
    expect(frame).toContain('Description: Describe token=***REDACTED***');
    expect(frame).toContain('Run tests token=***REDACTED***');
    expect(frame).toContain('Keep token=***REDACTED*** hidden');
    expect(frame).toContain('evidence token=***REDACTED***');
    expect(frame).toContain('route token=***REDACTED***');
    expect(frame).toContain('note token=***REDACTED***');
    expect(frame).not.toContain(rawToken);
    expect(frame).not.toContain('clipboard');
    expect(frame).not.toContain('\u001b');
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

    const ui = renderComponent(
      createElement(PlanEditorComponent, {
        filePath: join(tmpDir, TASKS_FILE),
        sessionDirPath: tmpDir,
        height: 16,
        width: 100,
      }),
    );
    await tick(20);
    ui.stdin.write('j');
    ui.stdin.write('j');
    ui.stdin.write('j');
    await tick();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Y approve checks');
    expect(frame).toContain('T004 pending src/d.ts');
    expect(frame).not.toContain('T001 pending src/a.ts');
  });

  it('keeps rich footer commands visible when no task rows fit', async () => {
    await writeTasksFile();

    const ui = renderComponent(
      createElement(PlanEditorComponent, {
        filePath: join(tmpDir, TASKS_FILE),
        sessionDirPath: tmpDir,
        height: 7,
        width: 80,
      }),
    );
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain('Y approve checks');
    });

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('N reject');
    expect(frame).toContain('q discard');
  });

  it('shows conflict and stale markers in selected task detail', async () => {
    await writeTasksFile();

    const ui = renderComponent(
      createElement(PlanEditorComponent, {
        filePath: join(tmpDir, TASKS_FILE),
        sessionDirPath: tmpDir,
        height: 42,
        width: 100,
      }),
    );
    await tick(20);
    planEditorStore.setReviewMetadata([
      {
        taskId: taskId('T001'),
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
        taskId: taskId('T001'),
        contextFit: 'overflow',
        conflict: {
          kind: 'current-task-conflict',
          files: ['src/a.ts'],
          affectedTaskIds: ['T001'],
        },
      },
    ]);

    const ui = renderComponent(
      createElement(BriefReviewView, {
        filePath: join(tmpDir, TASKS_FILE),
        height: 24,
        width: 100,
      }),
    );
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain('T001 pending src/a.ts');
    });

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('T001 pending src/a.ts');
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

    const ui = renderComponent(
      createElement(BriefReviewView, {
        filePath: join(tmpDir, TASKS_FILE),
        height: 13,
        width: 100,
      }),
    );
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain('5 more tasks (PageUp/PageDown, Ctrl+E/e)');
    });

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('PageDown/PageUp inspect all');
    expect(frame).toContain('T001');
    expect(frame).toContain('5 more tasks (PageUp/PageDown, Ctrl+E/e)');
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

    const ui = renderComponent(
      createElement(PlanEditorComponent, {
        filePath: join(tmpDir, TASKS_FILE),
        sessionDirPath: tmpDir,
        height: 34,
        width: 110,
      }),
    );
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
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await writeFile(join(tmpDir, 'src/a.ts'), 'export const value = 1;', 'utf-8');

    const ui = renderComponent(
      createElement(PlanEditorComponent, {
        filePath: join(tmpDir, TASKS_FILE),
        sessionDirPath: tmpDir,
        height: 30,
        width: 160,
      }),
    );
    await tick(20);
    planEditorStore.setReviewMetadata([
      {
        taskId: taskId('T001'),
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
    await tick(20);
    await vi.waitFor(() => {
      expect(ui.lastFrame()).toContain('estimate refreshed-current-code');
    });

    let frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Packet Preview T001');
    expect(frame).toContain('worker local-qwen');
    expect(frame).toContain('cost local');
    expect(frame).toContain('fit fits');
    expect(frame).toContain('tokens 1200');
    expect(frame).toContain('context 32768');
    expect(frame).toContain('current-code');
    expect(frame).toContain('estimate refreshed-current-code');
    expect(frame).toContain('system ');
    expect(frame).toContain('task ## Project: unknown');
    expect(frame).toContain('## Task: Task T001');

    ui.stdin.write('p');
    await tick(20);
    await vi.waitFor(() => {
      expect(ui.lastFrame()).not.toContain('Packet Preview T001');
    });

    frame = ui.lastFrame() ?? '';
    expect(frame).not.toContain('Packet Preview T001');
  });

  it('sanitizes selected-task packet preview excerpts', async () => {
    const rawToken = 'abcdefghijklmnopqrstuvwxyz1234567890abcdef';
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await writeFile(
      join(tmpDir, 'src/a.ts'),
      `export const secret = "token=${rawToken}";`,
      'utf-8',
    );
    await writeFile(
      join(tmpDir, TASKS_FILE),
      formatTasks([
        completeTask('T001', 'src/a.ts'),
        makeTask({
          id: 'T002',
          file: 'src/\u001b]52;c;clipboard\u0007b.ts',
          title: `Packet token=${rawToken}`,
          action: 'modify',
          currentCode: '',
          implementationSteps: [`Use token=${rawToken}`],
          typeDefs: '',
        }),
      ]),
      'utf-8',
    );

    const ui = renderComponent(
      createElement(PlanEditorComponent, {
        filePath: join(tmpDir, TASKS_FILE),
        sessionDirPath: tmpDir,
        height: 30,
        width: 180,
      }),
    );
    await tick(20);
    ui.stdin.write('j');
    await tick();
    ui.stdin.write('p');
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain('Packet Preview T002');
    });

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('task ## Project: unknown / ## Task: Packet token=');
    expect(frame).toContain('REDACTED');
    expect(frame).not.toContain(rawToken);
    expect(frame).not.toContain('clipboard');
    expect(frame).not.toContain('\u001b');
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
    await writeFile(
      join(tmpDir, 'src/target.ts'),
      'export const freshDiskValue = "fresh";',
      'utf-8',
    );

    const ui = renderComponent(
      createElement(PlanEditorComponent, {
        filePath: join(tmpDir, TASKS_FILE),
        sessionDirPath: tmpDir,
        height: 30,
        width: 1000,
      }),
    );
    await tick(20);

    ui.stdin.write('p');
    await tick(50);

    await vi.waitFor(() => {
      expect(ui.lastFrame()).toContain('freshDiskValue');
    });
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

    const ui = renderComponent(
      createElement(PlanEditorComponent, {
        filePath: join(tmpDir, TASKS_FILE),
        sessionDirPath: tmpDir,
        height: 30,
        width: 1000,
      }),
    );
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
    expect(frame).toContain('preview');
  });

  it('renders only the current plan editor feedback message', async () => {
    await writeTasksFile();

    const ui = renderComponent(
      createElement(PlanEditorComponent, {
        filePath: join(tmpDir, TASKS_FILE),
        sessionDirPath: tmpDir,
        height: 24,
        width: 120,
      }),
    );
    await tick(20);

    planEditorStore.setStatusMessage('saved message');
    planEditorStore.setSaveError('failed message');
    await tick();

    let frame = ui.lastFrame() ?? '';
    expect(frame).toContain('failed message');
    expect(frame).not.toContain('saved message');

    planEditorStore.setStatusMessage('saved again');
    await tick();

    frame = ui.lastFrame() ?? '';
    expect(frame).toContain('saved again');
    expect(frame).not.toContain('failed message');
  });

  it('updates packet preview when cursor moves', async () => {
    await writeTasksFile();

    const ui = renderComponent(
      createElement(PlanEditorComponent, {
        filePath: join(tmpDir, TASKS_FILE),
        sessionDirPath: tmpDir,
        height: 30,
        width: 160,
      }),
    );
    await tick(20);
    planEditorStore.setReviewMetadata([
      {
        taskId: taskId('T001'),
        workerProfile: 'local-qwen',
        selectedCostTier: 'local',
        contextFit: 'fits',
        estimatedTokens: 1200,
        contextLength: 32768,
      },
      {
        taskId: taskId('T002'),
        workerProfile: 'cheap-cloud',
        selectedCostTier: 'cheap',
        contextFit: 'tight',
        estimatedTokens: 7600,
        contextLength: 8192,
      },
    ]);
    await tick();

    ui.stdin.write('p');
    await tick(20);
    expect(ui.lastFrame() ?? '').toContain('Packet Preview T001');

    ui.stdin.write('j');
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Packet Preview T002');
    expect(frame).toContain('worker cheap-cloud');
    expect(frame).toContain('cost cheap');
    expect(frame).toContain('## Task: Task T002');
  });

  it('collapses packet preview and keeps footer visible in short layouts', async () => {
    await writeTasksFile();

    const ui = renderComponent(
      createElement(PlanEditorComponent, {
        filePath: join(tmpDir, TASKS_FILE),
        sessionDirPath: tmpDir,
        height: 16,
        width: 80,
      }),
    );
    await tick(20);

    ui.stdin.write('p');
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('packet preview collapsed');
    expect(frame).toContain('j/k navigate');
    expect(frame).toContain('Y approve checks');
  });

  it('shows both system and task excerpts when packet preview is expanded at medium height', async () => {
    await writeTasksFile();

    const ui = renderComponent(
      createElement(PlanEditorComponent, {
        filePath: join(tmpDir, TASKS_FILE),
        sessionDirPath: tmpDir,
        height: 20,
        width: 120,
      }),
    );
    await tick(20);

    ui.stdin.write('p');
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Packet Preview T001');
    expect(frame).toContain('system ');
    expect(frame).toContain('task ## Project: unknown');
    expect(frame).toContain('Y approve checks');
  });

  it('keeps save and edit labels visible in a narrow layout', async () => {
    await writeTasksFile();

    const ui = renderComponent(
      createElement(PlanEditorComponent, {
        filePath: join(tmpDir, TASKS_FILE),
        sessionDirPath: tmpDir,
        height: 18,
        width: 48,
      }),
    );
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

    const ui = renderComponent(
      createElement(BriefReviewView, {
        filePath: join(tmpDir, TASKS_FILE),
        height: 13,
        width: 48,
      }),
    );
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain('2 more tasks (PgUp/PgDn, e)');
    });

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('ready 0');
    expect(frame).toContain('PgDn/PgUp');
    expect(frame).toContain('T001');
    expect(frame).toContain('2 more tasks (PgUp/PgDn, e)');
  });
});
