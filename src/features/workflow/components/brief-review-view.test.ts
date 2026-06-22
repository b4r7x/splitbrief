import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createElement } from 'react';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import {
  formatQualityDisplay,
  formatTaskReviewLine,
  getTaskStatusSymbol,
  buildTaskDetailParts,
  formatTaskCount,
} from '../brief-review-format.js';
import { refreshPlanReviewMetadata } from '../plan-review-metadata.js';
import { buildRoutingPreviewMetadata } from '../../../engine/routing-preview.js';
import type { BriefQualityReport, BriefQualityIssue } from '../../../engine/spec/brief-quality.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { taskId } from '../../../core/schemas/task.js';
import { configStore } from '../../../stores/project/config.js';
import { planEditorStore } from '../../../stores/workflow/plan-editor.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { formatTasks } from '../../../engine/spec/formatter.js';
import { TASKS_FILE } from '../../../core/paths.js';
import { BriefReviewView } from './brief-review-view.js';

describe('formatQualityDisplay', () => {
  it('returns quality score formatted to 2 decimal places when report is present', () => {
    const report: BriefQualityReport = {
      version: 1,
      passed: true,
      score: 0.91,
      issues: [],
    };
    expect(formatQualityDisplay(report)).toBe('quality 0.91');
  });

  it('returns "quality n/a" when quality report is null', () => {
    expect(formatQualityDisplay(null)).toBe('quality n/a');
  });

  it('returns quality 1.00 for perfect score', () => {
    const report: BriefQualityReport = {
      version: 1,
      passed: true,
      score: 1,
      issues: [],
    };
    expect(formatQualityDisplay(report)).toBe('quality 1.00');
  });

  it('returns quality 0.00 for zero score', () => {
    const report: BriefQualityReport = {
      version: 1,
      passed: false,
      score: 0,
      issues: [],
    };
    expect(formatQualityDisplay(report)).toBe('quality 0.00');
  });
});

describe('formatTaskCount', () => {
  it('returns singular "task" for count of 1', () => {
    expect(formatTaskCount(1)).toBe('1 task');
  });

  it('returns plural "tasks" for count other than 1', () => {
    expect(formatTaskCount(0)).toBe('0 tasks');
    expect(formatTaskCount(4)).toBe('4 tasks');
  });
});

describe('getTaskStatusSymbol', () => {
  it('returns ✓ when there are no issues', () => {
    expect(getTaskStatusSymbol([])).toBe('✓');
  });

  it('returns ✓ when issues are only warnings', () => {
    const issues: BriefQualityIssue[] = [
      {
        taskId: taskId('T001'),
        severity: 'warning',
        code: 'missing_scope',
        message: 'no scope',
      },
    ];
    expect(getTaskStatusSymbol(issues)).toBe('✓');
  });

  it('returns ⚠ when any issue has severity error', () => {
    const issues: BriefQualityIssue[] = [
      {
        taskId: taskId('T001'),
        severity: 'error',
        code: 'missing_validation',
        message: 'no tests',
      },
    ];
    expect(getTaskStatusSymbol(issues)).toBe('⚠');
  });

  it('returns ⚠ when issues contain both errors and warnings', () => {
    const issues: BriefQualityIssue[] = [
      {
        taskId: taskId('T001'),
        severity: 'warning',
        code: 'missing_scope',
        message: 'no scope',
      },
      {
        taskId: taskId('T001'),
        severity: 'error',
        code: 'missing_validation',
        message: 'no tests',
      },
    ];
    expect(getTaskStatusSymbol(issues)).toBe('⚠');
  });
});

describe('buildTaskDetailParts', () => {
  it('shows validation count, evidence count, and scope when all are present', () => {
    const task = makeTask({
      tests: ['passes tsc', 'returns expected value'],
      evidence: ['brief-quality.json passes', 'tsc clean'],
      scope: { inBounds: ['src/foo.ts'], outOfBounds: ['other files'] },
    });
    const detail = buildTaskDetailParts(task);
    expect(detail).toContain('validation: 2 checks');
    expect(detail).toContain('evidence: 2');
    expect(detail).toContain('scope: set');
  });

  it('uses singular "check" for a single test', () => {
    const task = makeTask({
      tests: ['passes tsc'],
      evidence: ['brief-quality.json'],
      scope: { inBounds: ['src/foo.ts'], outOfBounds: [] },
    });
    expect(buildTaskDetailParts(task)).toContain('validation: 1 check');
  });

  it('omits validation section when tests array is empty', () => {
    const task = makeTask({
      tests: [],
      evidence: ['some evidence'],
      scope: { inBounds: ['src/foo.ts'], outOfBounds: [] },
    });
    const detail = buildTaskDetailParts(task);
    expect(detail).not.toContain('validation:');
    expect(detail).toContain('evidence: 1');
  });

  it('omits evidence section when evidence array is empty or missing', () => {
    const task = makeTask({
      tests: ['passes tsc'],
      evidence: [],
      scope: { inBounds: ['src/foo.ts'], outOfBounds: [] },
    });
    const detail = buildTaskDetailParts(task);
    expect(detail).not.toContain('evidence:');
  });

  it('shows scope: missing when scope is not set', () => {
    const task = makeTask({
      tests: ['passes tsc'],
      evidence: ['some evidence'],
      scope: undefined,
    });
    const detail = buildTaskDetailParts(task);
    expect(detail).toContain('scope: missing');
  });

  it('shows scope: missing when scope bounds are empty arrays', () => {
    const task = makeTask({
      tests: ['passes tsc'],
      evidence: ['some evidence'],
      scope: { inBounds: [], outOfBounds: [] },
    });
    const detail = buildTaskDetailParts(task);
    expect(detail).toContain('scope: missing');
  });
});

describe('BriefReviewView', () => {
  it('renders simple task rows with sanitized task and review metadata text', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'brief-review-sanitize-test-'));
    try {
      configStore.__testReset({ config: makeConfig(), projectDir });
      const rawToken = 'abcdefghijklmnopqrstuvwxyz1234567890abcdef';
      const filePath = join(projectDir, TASKS_FILE);
      await writeFile(
        filePath,
        formatTasks([
          makeTask({
            id: 'T001',
            file: 'src/\u001b]52;c;clipboard\u0007secret.ts',
            title: `Sanitize token=${rawToken}`,
            evidence: ['review proof'],
            scope: { inBounds: ['src/secret.ts'], outOfBounds: [] },
          }),
        ]),
        'utf-8',
      );
      const ui = renderFeature(
        createElement(BriefReviewView, { filePath, height: 16, width: 120 }),
      );
      await vi.waitFor(() => {
        expect(ui.lastFrame() ?? '').toContain('Sanitize token=***REDACTED***');
      });
      planEditorStore.setReviewMetadata([
        {
          taskId: taskId('T001'),
          workerProfile: `token=${rawToken}`,
          contextFit: 'fits',
          conflict: {
            kind: 'current-task-conflict',
            files: ['src/\u001b]52;c;clipboard\u0007conflict.ts'],
            affectedTaskIds: ['T001'],
          },
        },
      ]);
      await tick();

      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('src/secret.ts');
      expect(frame).toContain('Sanitize token=***REDACTED***');
      expect(frame).toContain('worker token=***REDACTED***');
      expect(frame).toContain('conflict src/conflict.ts');
      expect(frame).not.toContain(rawToken);
      expect(frame).not.toContain('clipboard');
      expect(frame).not.toContain('\u001b');
      ui.unmount();
    } finally {
      configStore.__testReset();
      planEditorStore.__testReset();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('scrolls hidden task lists to later task ids', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'brief-review-scroll-test-'));
    try {
      configStore.__testReset({ config: makeConfig(), projectDir });
      reviewStore.setReviewFile(join(projectDir, TASKS_FILE));
      const tasks = Array.from({ length: 20 }, (_, index) =>
        makeTask({
          id: `T${String(index + 1).padStart(3, '0')}`,
          title: `Task ${index + 1}`,
          file: `src/task-${index + 1}.ts`,
          evidence: ['reviewable proof'],
          scope: { inBounds: [`src/task-${index + 1}.ts`], outOfBounds: [] },
        }),
      );
      const filePath = join(projectDir, TASKS_FILE);
      await writeFile(filePath, formatTasks(tasks), 'utf-8');

      const ui = renderFeature(
        createElement(BriefReviewView, { filePath, height: 14, width: 120 }),
      );
      await tick(20);
      expect(ui.lastFrame() ?? '').toContain('T001');

      reviewStore.setScrollOffset(12);
      await tick();

      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('T013');
      expect(frame).not.toContain('T001');
      expect(frame).toContain('PageDown/PageUp inspect all');
      expect(frame).toContain('Ctrl+E/e');
      ui.unmount();
    } finally {
      reviewStore.clearReview();
      configStore.__testReset();
      planEditorStore.__testReset();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('keeps compact command affordances visible at 48 columns', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'brief-review-narrow-test-'));
    try {
      configStore.__testReset({ config: makeConfig(), projectDir });
      const tasks = Array.from({ length: 6 }, (_, index) =>
        makeTask({
          id: `T${String(index + 1).padStart(3, '0')}`,
          title: `Task ${index + 1}`,
          file: `src/task-${index + 1}.ts`,
          evidence: ['reviewable proof'],
          scope: { inBounds: [`src/task-${index + 1}.ts`], outOfBounds: [] },
        }),
      );
      const filePath = join(projectDir, TASKS_FILE);
      await writeFile(filePath, formatTasks(tasks), 'utf-8');

      const ui = renderFeature(createElement(BriefReviewView, { filePath, height: 13, width: 48 }));
      await vi.waitFor(() => {
        const frame = ui.lastFrame() ?? '';
        expect(frame).toContain('PgDn/PgUp');
        expect(frame).toContain('e rich');
        expect(frame).toContain('reject');
      });
      const frame = ui.lastFrame() ?? '';
      expect(frame).not.toContain('PageDown/PageUp inspect all');
      expect(frame.split('\n').length).toBeLessThanOrEqual(13);
      ui.unmount();
    } finally {
      configStore.__testReset();
      planEditorStore.__testReset();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('keeps the bottom hint visible when simple review load fails', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'brief-review-load-error-test-'));
    try {
      configStore.__testReset({ config: makeConfig(), projectDir });
      const filePath = join(projectDir, TASKS_FILE);

      const ui = renderFeature(createElement(BriefReviewView, { filePath, height: 8, width: 48 }));
      await vi.waitFor(() => {
        const frame = ui.lastFrame() ?? '';
        expect(frame).toContain('Failed to load Task Briefs');
        expect(frame).toContain('approve');
        expect(frame).toContain('reject');
      });
      expect((ui.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(8);
      ui.unmount();
    } finally {
      configStore.__testReset();
      planEditorStore.__testReset();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('preserves the task title when the simple row path is long', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'brief-review-long-path-test-'));
    try {
      configStore.__testReset({ config: makeConfig(), projectDir });
      const filePath = join(projectDir, TASKS_FILE);
      await writeFile(
        filePath,
        formatTasks([
          makeTask({
            id: 'T001',
            file: 'src/features/workflow/components/extremely/deep/path/to/generated/review/file.ts',
            title: 'KeepTitleVisible',
            evidence: ['reviewable proof'],
            scope: {
              inBounds: ['src/features/workflow/components'],
              outOfBounds: [],
            },
          }),
        ]),
        'utf-8',
      );

      const ui = renderFeature(createElement(BriefReviewView, { filePath, height: 14, width: 56 }));
      await vi.waitFor(() => {
        const frame = ui.lastFrame() ?? '';
        expect(frame).toContain('KeepTitleVisible');
        expect(frame).toContain('…');
      });
      ui.unmount();
    } finally {
      configStore.__testReset();
      planEditorStore.__testReset();
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});

describe('buildRoutingPreviewMetadata', () => {
  it('returns refreshed metadata without writing it to the plan editor store', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'brief-review-refresh-test-'));
    try {
      configStore.__testReset({ config: makeConfig(), projectDir });
      planEditorStore.__testReset();
      const task = makeTask({ action: 'modify', file: 'missing.ts' });

      const metadata = await refreshPlanReviewMetadata([task]);

      if (metadata === null) throw new Error('expected routing metadata');
      expect(metadata).toHaveLength(1);
      expect(metadata[0]).toMatchObject({
        taskId: task.id,
        estimateStatus: 'missing-current-code',
      });
      expect(planEditorStore.get().reviewMetadata.size).toBe(0);
    } finally {
      configStore.__testReset();
      planEditorStore.__testReset();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('routes using currentCode refreshed from disk when available', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'brief-review-routing-test-'));
    try {
      await writeFile(
        join(projectDir, 'target.ts'),
        Array.from({ length: 1200 }, (_, i) => `export const value${i} = ${i};`).join('\n'),
        'utf-8',
      );
      const config = {
        ...makeConfig(),
        implementerProfiles: {
          profiles: {
            'local-small': {
              kind: 'api' as const,
              provider: 'ollama',
              apiBase: 'http://localhost:11434/v1',
              model: 'small',
              contextLength: 2000,
              costTier: 'local' as const,
            },
            'cheap-large': {
              kind: 'api' as const,
              provider: 'ollama',
              apiBase: 'http://localhost:11434/v1',
              model: 'large',
              contextLength: 40_000,
              costTier: 'cheap' as const,
            },
          },
        },
      };
      const task = makeTask({ action: 'modify', file: 'target.ts' });

      const metadata = await buildRoutingPreviewMetadata([task], {
        config,
        projectDir,
      });

      expect(metadata[0]).toMatchObject({
        taskId: task.id,
        workerProfile: 'cheap-large',
        selectedCostTier: 'cheap',
        estimateStatus: 'refreshed-current-code',
      });
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('labels modify-task estimates when currentCode is missing at review time', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'brief-review-missing-code-test-'));
    try {
      const task = makeTask({ action: 'modify', file: 'missing.ts' });

      const metadata = await buildRoutingPreviewMetadata([task], {
        config: makeConfig(),
        projectDir,
      });

      expect(metadata[0]).toMatchObject({
        taskId: task.id,
        estimateStatus: 'missing-current-code',
        validationStatus: 'warn',
        risk: 'high',
      });
      expect(formatTaskReviewLine(task, [], metadata[0])).toContain(
        'estimate missing-current-code',
      );
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('does not reuse stale brief currentCode when the target file is missing', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'brief-review-stale-code-test-'));
    try {
      const task = makeTask({
        action: 'modify',
        file: 'missing.ts',
        currentCode: 'export const stale = true;\n',
      });

      const metadata = await buildRoutingPreviewMetadata([task], {
        config: makeConfig(),
        projectDir,
      });

      expect(metadata[0]).toMatchObject({
        taskId: task.id,
        estimateStatus: 'missing-current-code',
        validationStatus: 'warn',
        risk: 'high',
      });
      expect(metadata[0]?.routingReason).toContain('missing current code');
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
