import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createElement } from 'react';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { cursorGlyph } from '../../../../components/pickers/cursor-glyph.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { configStore } from '../../../../stores/project/config.js';
import { reviewStore } from '../../../../stores/workflow/review.js';
import { focusStore } from '../../../../stores/ui/focus.js';
import { hoverStore } from '../../../../stores/ui/hover.js';
import { formatTasks } from '../../../../engine/spec/formatter.js';
import { TASKS_FILE } from '../../../../core/paths.js';
import { SIMPLE_REVIEW_BASE_CHROME_ROWS } from '../../layout/brief-review.js';
import { briefListTopOffset } from '../../layout/hit-test.js';
import { BriefReviewView } from './view.js';

function normalizeFrame(text: string): string {
  return stripAnsiStyles(text)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trimEnd())
    .join('\n');
}

function lineFor(frame: string, token: string): string {
  return (
    stripAnsiStyles(frame)
      .split('\n')
      .find((line) => line.includes(token)) ?? ''
  );
}

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

describe('BriefReviewView focus and hover', () => {
  async function writeBriefTasks(projectDir: string, count: number): Promise<string> {
    const tasks = Array.from({ length: count }, (_, index) =>
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
    return filePath;
  }

  it('paints the cursor only on the focus-store brief row', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'brief-review-focus-test-'));
    try {
      focusStore.clear();
      configStore.__testReset({ config: makeConfig(), projectDir });
      const filePath = await writeBriefTasks(projectDir, 6);

      const ui = renderFeature(
        createElement(BriefReviewView, { filePath, height: 16, width: 120 }),
      );
      await vi.waitFor(() => {
        expect(ui.lastFrame() ?? '').toContain('T001');
      });
      expect(ui.lastFrame() ?? '').not.toContain(cursorGlyph());

      focusStore.set('brief', 0);
      await tick();
      expect(ui.lastFrame() ?? '').toContain(cursorGlyph());
      expect(lineFor(ui.lastFrame() ?? '', 'T001')).toContain(cursorGlyph());
      expect(lineFor(ui.lastFrame() ?? '', 'T002')).not.toContain(cursorGlyph());

      focusStore.clear();
      await tick();
      expect(ui.lastFrame() ?? '').not.toContain(cursorGlyph());
      ui.unmount();
    } finally {
      focusStore.clear();
      configStore.__testReset();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('renders the first task row exactly where the brief hit-test offset lands it', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'brief-review-calibration-test-'));
    try {
      focusStore.clear();
      reviewStore.clearReview();
      configStore.__testReset({ config: makeConfig(), projectDir });
      const filePath = await writeBriefTasks(projectDir, 6);

      const ui = renderFeature(
        createElement(BriefReviewView, { filePath, height: 16, width: 120 }),
      );
      await vi.waitFor(() => {
        expect(ui.lastFrame() ?? '').toContain('T001');
      });

      // Locate T001 in the real rendered frame and pin the hit-test offset to it. The frame's top
      // line corresponds to contentRect.top, so the rendered 0-based row index of T001 is exactly
      // the offset hitBriefTaskRow adds to rect.top. Asserting against briefListTopOffset (not just
      // the chrome constant) catches drift between what is rendered and what is clicked.
      const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
      const firstRowIndex = lines.findIndex((line) => line.includes('T001'));
      expect(firstRowIndex).toBe(briefListTopOffset({ hasLoadError: false }));
      expect(briefListTopOffset({ hasLoadError: false })).toBe(SIMPLE_REVIEW_BASE_CHROME_ROWS);
      ui.unmount();
    } finally {
      focusStore.clear();
      reviewStore.clearReview();
      configStore.__testReset();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('renders the load-error banner exactly one line tall at the calibrated brief offset', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'brief-review-load-error-calibration-'));
    try {
      focusStore.clear();
      reviewStore.clearReview();
      configStore.__testReset({ config: makeConfig(), projectDir });
      // No tasks file on disk → the loader fails and the quiet load-error banner renders.
      const filePath = join(projectDir, TASKS_FILE);

      const ui = renderFeature(createElement(BriefReviewView, { filePath, height: 8, width: 80 }));
      await vi.waitFor(() => {
        expect(ui.lastFrame() ?? '').toContain("couldn't load briefs");
      });

      const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
      const errorRowIndex = lines.findIndex((line) => line.includes("couldn't load briefs"));
      // The banner occupies the row where the no-error task list begins and is exactly one line
      // tall, so the load-error offset pushes the would-be first task row down by that one line.
      expect(errorRowIndex).toBe(briefListTopOffset({ hasLoadError: false }));
      expect(briefListTopOffset({ hasLoadError: true })).toBe(errorRowIndex + 1);
      ui.unmount();
    } finally {
      focusStore.clear();
      reviewStore.clearReview();
      configStore.__testReset();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('publishes briefSources and briefPaths to the review store aligned to render order', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'brief-review-publication-test-'));
    try {
      focusStore.clear();
      reviewStore.clearReview();
      configStore.__testReset({ config: makeConfig(), projectDir });
      const filePath = await writeBriefTasks(projectDir, 4);

      const ui = renderFeature(
        createElement(BriefReviewView, { filePath, height: 16, width: 120 }),
      );
      await vi.waitFor(() => {
        expect(reviewStore.get().briefSources).toHaveLength(4);
        expect(reviewStore.get().briefPaths).toHaveLength(4);
      });

      const sources = reviewStore.get().briefSources;
      expect(sources[0]).toContain('id: T001');
      expect(sources[0]).toContain('Task 1');
      expect(sources[0]).toContain('## ');
      expect(sources[3]).toContain('id: T004');
      expect(reviewStore.get().briefPaths).toEqual([
        'src/task-1.ts',
        'src/task-2.ts',
        'src/task-3.ts',
        'src/task-4.ts',
      ]);
      ui.unmount();
    } finally {
      focusStore.clear();
      reviewStore.clearReview();
      configStore.__testReset();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('reloads the same task-brief path on revision without showing the prior rows', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'brief-review-revision-test-'));
    try {
      focusStore.clear();
      reviewStore.clearReview();
      configStore.__testReset({ config: makeConfig(), projectDir });
      const filePath = join(projectDir, TASKS_FILE);
      reviewStore.setReviewFile(filePath);
      await writeFile(
        filePath,
        formatTasks([makeTask({ id: 'T001', title: 'Before revision', file: 'src/before.ts' })]),
        'utf8',
      );

      const ui = renderFeature(
        createElement(BriefReviewView, { filePath, height: 16, width: 120 }),
      );
      await vi.waitFor(() => {
        expect(ui.lastFrame() ?? '').toContain('Before revision');
      });

      await writeFile(
        filePath,
        formatTasks([makeTask({ id: 'T002', title: 'After revision', file: 'src/after.ts' })]),
        'utf8',
      );
      reviewStore.reloadReviewFile();
      await tick();
      expect(ui.lastFrame() ?? '').not.toContain('Before revision');

      await vi.waitFor(() => {
        expect(ui.lastFrame() ?? '').toContain('After revision');
        expect(reviewStore.get().briefSources[0]).toContain('id: T002');
        expect(reviewStore.get().briefPaths).toEqual(['src/after.ts']);
      });
      ui.unmount();
    } finally {
      focusStore.clear();
      reviewStore.clearReview();
      configStore.__testReset();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('publishes only the current owner when same-path brief loads settle out of order', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'brief-review-owner-race-test-'));
    const loaderModule = await import('../../brief-review-loader.js');
    type BriefLoadResult = Awaited<ReturnType<typeof loaderModule.loadBriefReviewData>>;
    const pending: Array<{
      resolve: (result: BriefLoadResult) => void;
      reject: (error: Error) => void;
    }> = [];
    const loader = vi.spyOn(loaderModule, 'loadBriefReviewData').mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          pending.push({ resolve, reject });
        }),
    );
    try {
      focusStore.clear();
      reviewStore.clearReview();
      configStore.__testReset({ config: makeConfig(), projectDir });
      const filePath = join(projectDir, TASKS_FILE);
      await writeFile(filePath, '', 'utf8');
      reviewStore.setReviewFile(filePath);
      const ui = renderFeature(
        createElement(BriefReviewView, { filePath, height: 16, width: 120 }),
      );
      await vi.waitFor(() => {
        expect(pending).toHaveLength(1);
      });

      reviewStore.setReviewFile(filePath);
      await tick();
      expect(ui.lastFrame() ?? '').not.toContain('First owner');
      await vi.waitFor(() => {
        expect(pending).toHaveLength(2);
      });
      reviewStore.setReviewFile(filePath);
      await tick();
      await vi.waitFor(() => {
        expect(pending).toHaveLength(3);
      });

      const currentTask = makeTask({
        id: 'T003',
        title: 'Current owner',
        file: 'src/current.ts',
      });
      pending[2]?.resolve({
        tasks: [currentTask],
        quality: null,
        reviewMetadata: new Map(),
        briefSources: ['id: T003\nCurrent owner'],
      });
      await vi.waitFor(() => {
        expect(ui.lastFrame() ?? '').toContain('Current owner');
      });

      pending[1]?.reject(new Error('stale owner failure'));
      pending[0]?.resolve({
        tasks: [makeTask({ id: 'T001', title: 'First owner', file: 'src/first.ts' })],
        quality: null,
        reviewMetadata: new Map(),
        briefSources: ['id: T001\nFirst owner'],
      });
      await tick(20);

      expect(ui.lastFrame() ?? '').toContain('Current owner');
      expect(ui.lastFrame() ?? '').not.toContain('First owner');
      expect(reviewStore.get().loadError).toBeNull();
      expect(reviewStore.get().briefSources).toEqual(['id: T003\nCurrent owner']);
      expect(reviewStore.get().briefPaths).toEqual(['src/current.ts']);
      ui.unmount();
    } finally {
      loader.mockRestore();
      focusStore.clear();
      reviewStore.clearReview();
      configStore.__testReset();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('aligns the focus accent to the visible window after scrolling', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'brief-review-focus-window-test-'));
    try {
      focusStore.clear();
      reviewStore.clearReview();
      configStore.__testReset({ config: makeConfig(), projectDir });
      const filePath = await writeBriefTasks(projectDir, 20);

      const ui = renderFeature(
        createElement(BriefReviewView, { filePath, height: 14, width: 120 }),
      );
      await vi.waitFor(() => {
        expect(ui.lastFrame() ?? '').toContain('T001');
      });

      reviewStore.setScrollOffset(5);
      focusStore.set('brief', 7);
      await tick();

      const frame = ui.lastFrame() ?? '';
      expect(stripAnsiStyles(frame)).not.toContain('T001');
      expect(lineFor(frame, 'T008')).toContain(cursorGlyph());
      expect(lineFor(frame, 'T006')).not.toContain(cursorGlyph());
      ui.unmount();
    } finally {
      focusStore.clear();
      reviewStore.clearReview();
      configStore.__testReset();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('does not paint a cursor on hidden brief rows when the viewport fits zero tasks', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'brief-review-zero-visible-test-'));
    try {
      focusStore.clear();
      reviewStore.clearReview();
      configStore.__testReset({ config: makeConfig(), projectDir });
      const filePath = await writeBriefTasks(projectDir, 6);

      const ui = renderFeature(createElement(BriefReviewView, { filePath, height: 4, width: 120 }));
      await vi.waitFor(() => {
        expect(reviewStore.get().briefSources).toHaveLength(6);
      });

      expect(reviewStore.get().visibleBriefCount).toBe(0);
      focusStore.set('brief', 0);
      await tick();
      expect(ui.lastFrame() ?? '').not.toContain(cursorGlyph());
      ui.unmount();
    } finally {
      focusStore.clear();
      reviewStore.clearReview();
      configStore.__testReset();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('paints a hover band as styling only, leaving rows and text unchanged', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'brief-review-hover-test-'));
    try {
      hoverStore.clear();
      focusStore.clear();
      configStore.__testReset({ config: makeConfig(), projectDir });
      const filePath = await writeBriefTasks(projectDir, 6);

      const ui = renderFeature(
        createElement(BriefReviewView, { filePath, height: 16, width: 120 }),
      );
      await vi.waitFor(() => {
        expect(ui.lastFrame() ?? '').toContain('T001');
      });
      const before = ui.lastFrame() ?? '';
      const colorOn = before.includes(String.fromCharCode(27));

      hoverStore.set('brief', 0);
      await tick();
      const after = ui.lastFrame() ?? '';

      expect(normalizeFrame(after)).toBe(normalizeFrame(before));
      expect(after.split('\n').length).toBe(before.split('\n').length);
      if (colorOn) expect(after).not.toBe(before);
      ui.unmount();
    } finally {
      hoverStore.clear();
      focusStore.clear();
      configStore.__testReset();
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
