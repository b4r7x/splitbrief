import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createElement } from 'react';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { configStore } from '../../../../stores/project/config.js';
import { reviewStore } from '../../../../stores/workflow/review.js';
import { formatTasks } from '../../../../engine/spec/formatter.js';
import { TASKS_FILE } from '../../../../core/paths.js';
import { BriefReviewView } from './view.js';

describe('BriefReviewView', () => {
  it('renders simple task rows with sanitized task and review metadata text', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'brief-review-sanitize-test-'));
    try {
      const rawToken = 'abcdefghijklmnopqrstuvwxyz1234567890abcdef';
      configStore.__testReset({
        config: {
          ...makeConfig(),
          implementerProfiles: {
            profiles: {
              [`token=${rawToken}`]: {
                kind: 'api' as const,
                provider: 'ollama',
                service: 'ollama',
                offering: 'local' as const,
                apiBase: 'http://localhost:11434/v1',
                model: 'large',
                contextLength: 40_000,
                costTier: 'cheap' as const,
              },
            },
          },
        },
        projectDir,
      });
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

      const frame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(frame).toContain('src/secret.ts');
      expect(frame).toContain('Sanitize token=***REDACTED***');
      expect(frame).not.toContain(rawToken);
      expect(frame).not.toContain('clipboard');
      expect(frame).not.toContain('\u001b');
      ui.unmount();
    } finally {
      configStore.__testReset();
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

      reviewStore.setScrollOffset(5);
      await tick();

      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('T013');
      expect(frame).not.toContain('T001');
      expect(frame).toContain('↑ 5 more');
      expect(frame).toContain('↓');
      expect(frame).toContain('pgup/pgdn scroll');
      ui.unmount();
    } finally {
      reviewStore.clearReview();
      configStore.__testReset();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('renders single-line task rows at 48 columns', async () => {
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
        expect(frame).toContain('task briefs');
        expect(frame).toContain('T001');
        expect(frame).toContain('Task 1');
      });
      const frame = ui.lastFrame() ?? '';
      expect(frame).not.toContain('validation:');
      expect(frame).not.toContain('scope:');
      expect(frame.split('\n').length).toBeLessThanOrEqual(13);
      ui.unmount();
    } finally {
      configStore.__testReset();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('renders a quiet load-error line when simple review load fails', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'brief-review-load-error-test-'));
    try {
      configStore.__testReset({ config: makeConfig(), projectDir });
      const filePath = join(projectDir, TASKS_FILE);

      const ui = renderFeature(createElement(BriefReviewView, { filePath, height: 8, width: 48 }));
      await vi.waitFor(() => {
        const frame = ui.lastFrame() ?? '';
        expect(frame).toContain("couldn't load briefs");
        expect(frame).toContain('task briefs');
      });
      expect((ui.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(8);
      ui.unmount();
    } finally {
      configStore.__testReset();
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
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
