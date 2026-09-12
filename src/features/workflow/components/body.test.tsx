import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makePlannerText } from '#testing/helpers/events/planner.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { configStore } from '../../../stores/project/config.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { TASKS_FILE } from '../../../core/paths.js';
import { formatTasks } from '../../../engine/spec/formatter.js';
import { REVIEW_MIN_ROWS } from '../layout/rect.js';
import { WorkflowBody } from './body.js';
import type { UseInputModeResult } from '../hooks/use-input-mode.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'workflow-body-test-'));
  eventsStore.__testReset();
  reviewStore.clearReview();
  configStore.__testReset({ config: makeConfig(), projectDir: tmpDir });
});

afterEach(async () => {
  eventsStore.__testReset();
  reviewStore.clearReview();
  configStore.__testReset();
  await rm(tmpDir, { recursive: true, force: true });
});

function reviewInputMode(): UseInputModeResult {
  return {
    mode: 'review',
    hint: '',
    questionEpoch: 0,
    setReviewMode: vi.fn(),
    setQuestionMode: vi.fn(),
    resolve: vi.fn(),
    resetMode: vi.fn(),
  };
}

function normalInputMode(): UseInputModeResult {
  return {
    ...reviewInputMode(),
    mode: 'normal',
  };
}

function questionInputMode(hint: string): UseInputModeResult {
  return {
    ...reviewInputMode(),
    mode: 'question',
    hint,
  };
}

function rightPaneBottomRow(frame: string, startColumn: number): number {
  const rows = stripAnsiStyles(frame)
    .split('\n')
    .flatMap((line, row) => {
      const corner = line[startColumn];
      return (corner === '+' || corner === '└') && /[-─]{2,}/u.test(line.slice(startColumn))
        ? [row]
        : [];
    });
  return rows.length > 0 ? (rows[rows.length - 1] ?? -1) : -1;
}

describe('WorkflowBody brief review rendering', () => {
  it.each([0, 1, 2])(
    'bounds conversation rendering at a %i-row visible-sidebar height',
    (height) => {
      const ui = renderFeature(
        <WorkflowBody
          showSidebar={true}
          sidebarWidth={34}
          inputMode={normalInputMode()}
          reviewFilePath={null}
          contentHeight={height}
          contentWidth={80}
        />,
      );

      const frame = ui.lastFrame() ?? '';
      const lines = frame === '' ? [] : frame.split('\n');
      expect(lines.length, `conversation rows at height ${height}`).toBeLessThanOrEqual(height);
      ui.unmount();
    },
  );

  it.each([0, 1, 2])('bounds review rendering at a %i-row visible-sidebar height', (height) => {
    reviewStore.setReviewArtifact('# Review\n\nA review line.');
    const ui = renderFeature(
      <WorkflowBody
        showSidebar={true}
        sidebarWidth={34}
        inputMode={reviewInputMode()}
        reviewFilePath="review.md"
        contentHeight={height}
        contentWidth={80}
      />,
    );

    const frame = ui.lastFrame() ?? '';
    const lines = frame === '' ? [] : frame.split('\n');
    expect(lines.length, `review rows at height ${height}`).toBeLessThanOrEqual(height);
    ui.unmount();
  });

  it('yields the region to the conversation when the frame cannot seat a document row', () => {
    reviewStore.setReviewArtifact('# Review\n\nA review line.');
    const ui = renderFeature(
      <WorkflowBody
        showSidebar={false}
        sidebarWidth={0}
        inputMode={reviewInputMode()}
        reviewFilePath="review.md"
        contentHeight={REVIEW_MIN_ROWS - 1}
        contentWidth={80}
      />,
    );

    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('no events yet');
    expect(frame).not.toContain('Custom planner artifact');
    ui.unmount();
  });

  it('renders the review frame with its title from the first height that seats a document row', () => {
    reviewStore.setReviewArtifact('# Review\n\nA review line.');
    const ui = renderFeature(
      <WorkflowBody
        showSidebar={false}
        sidebarWidth={0}
        inputMode={reviewInputMode()}
        reviewFilePath="review.md"
        contentHeight={REVIEW_MIN_ROWS}
        contentWidth={80}
      />,
    );

    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('Custom planner artifact');
    ui.unmount();
  });

  it('lets the conversation, document, and brief panes reach the same body bottom', async () => {
    const contentHeight = 8;
    const sidebarWidth = 34;
    const contentStartColumn = sidebarWidth + 2;
    eventsStore.__testReset({
      events: [
        makePlannerText({
          text: Array.from({ length: 20 }, (_, index) => `transcript-${index + 1}`).join('\n'),
        }),
      ],
    });
    const briefPath = join(tmpDir, TASKS_FILE);
    await writeFile(
      briefPath,
      formatTasks([makeTask({ id: 'T001', title: 'Review task' })]),
      'utf8',
    );
    reviewStore.setReviewArtifact('# Review\n\nA review line.');

    const ui = renderFeature(
      <WorkflowBody
        showSidebar={true}
        sidebarWidth={sidebarWidth}
        inputMode={normalInputMode()}
        reviewFilePath={null}
        contentHeight={contentHeight}
        contentWidth={80}
      />,
      { cols: 120, rows: 24 },
    );
    await flushEffects();
    const conversationFrame = stripAnsiStyles(ui.lastFrame() ?? '');
    const conversationLines = conversationFrame.split('\n');
    const conversationBottomRow = conversationLines.findIndex((line) =>
      line.includes('transcript-20'),
    );

    ui.rerender(
      <WorkflowBody
        showSidebar={true}
        sidebarWidth={sidebarWidth}
        inputMode={reviewInputMode()}
        reviewFilePath="review.md"
        contentHeight={contentHeight}
        contentWidth={80}
      />,
    );
    await flushEffects();
    const documentBottomRow = rightPaneBottomRow(ui.lastFrame() ?? '', contentStartColumn);

    reviewStore.setReviewFile(briefPath);
    ui.rerender(
      <WorkflowBody
        showSidebar={true}
        sidebarWidth={sidebarWidth}
        inputMode={reviewInputMode()}
        reviewFilePath={briefPath}
        contentHeight={contentHeight}
        contentWidth={80}
      />,
    );
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain('Review task');
    });
    const briefBottomRow = rightPaneBottomRow(ui.lastFrame() ?? '', contentStartColumn);

    expect(conversationBottomRow).toBe(contentHeight - 1);
    expect(documentBottomRow).toBe(contentHeight - 1);
    expect(briefBottomRow).toBe(contentHeight - 1);
    ui.unmount();
  });

  it('renders conversation content flush against the terminal edge inside the main workflow body', () => {
    const ui = renderFeature(
      <WorkflowBody
        showSidebar={false}
        sidebarWidth={0}
        inputMode={normalInputMode()}
        reviewFilePath={null}
        contentHeight={4}
        contentWidth={40}
      />,
    );

    const frame = ui.lastFrame() ?? '';
    const lines = frame.split('\n');
    const row = lines.find((line) => line.includes('no events yet')) ?? '';

    // No top-gap row: the body starts on its first line, directly under the header divider.
    expect(lines[0]).toContain('no events yet');
    // Flush layout (WORKFLOW_CONTENT_PADDING_X = 0): the transcript text sits at column 0, no inset.
    expect(row.startsWith('no events yet')).toBe(true);

    ui.unmount();
  });

  it('uses a one-row body for content instead of the top gap', () => {
    const ui = renderFeature(
      <WorkflowBody
        showSidebar={false}
        sidebarWidth={0}
        inputMode={normalInputMode()}
        reviewFilePath={null}
        contentHeight={1}
        contentWidth={40}
      />,
    );

    const frame = ui.lastFrame() ?? '';
    const lines = frame.split('\n');
    expect(frame).toContain('no events yet');
    // No leading blank gap row: the lone content row sits flush against the chrome above, matching
    // the hit-test geometry that drops the top gap at this height.
    expect(lines[0]).not.toBe('');
    expect(lines[0]).toContain('no events yet');

    ui.unmount();
  });

  it('lets the visible-sidebar transcript reach the sidebar bottom border row', () => {
    const contentHeight = 8;
    eventsStore.__testReset({
      events: [
        makePlannerText({
          text: Array.from({ length: 20 }, (_, index) => `transcript-${index + 1}`).join('\n'),
        }),
      ],
    });
    const ui = renderFeature(
      <WorkflowBody
        showSidebar={true}
        sidebarWidth={34}
        inputMode={normalInputMode()}
        reviewFilePath={null}
        contentHeight={contentHeight}
        contentWidth={80}
      />,
    );

    const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
    const lastTranscriptLine = lines.findIndex((line) => line.includes('transcript-20'));
    const bottomBorderRow = contentHeight - 1;

    expect(lines).toHaveLength(contentHeight);
    expect(lines[bottomBorderRow]?.[0]).toMatch(/[+└]/);
    expect(lastTranscriptLine).toBe(bottomBorderRow);
    expect(lines[lastTranscriptLine]).toContain('transcript-20');

    ui.unmount();
  });

  it('lets the hidden-sidebar transcript use the full body height', () => {
    const contentHeight = 8;
    eventsStore.__testReset({
      events: [
        makePlannerText({
          text: Array.from({ length: 20 }, (_, index) => `transcript-${index + 1}`).join('\n'),
        }),
      ],
    });
    const ui = renderFeature(
      <WorkflowBody
        showSidebar={false}
        sidebarWidth={0}
        inputMode={normalInputMode()}
        reviewFilePath={null}
        contentHeight={contentHeight}
        contentWidth={80}
      />,
    );

    const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
    const lastTranscriptLine = lines.findIndex((line) => line.includes('transcript-20'));

    expect(lines).toHaveLength(contentHeight);
    expect(lastTranscriptLine).toBe(contentHeight - 1);
    expect(lines[lastTranscriptLine]).toContain('transcript-20');

    ui.unmount();
  });

  it('keeps the conversation visible in question mode (the prompt panel lives above the composer)', () => {
    const ui = renderFeature(
      <WorkflowBody
        showSidebar={false}
        sidebarWidth={0}
        inputMode={questionInputMode('Task interrupted. Enter instructions to continue:')}
        reviewFilePath={null}
        contentHeight={4}
        contentWidth={80}
      />,
    );

    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('no events yet');
    expect(frame).not.toContain('Task interrupted');

    ui.unmount();
  });

  it('clears the scroll labels when conversation mode is replaced by a review', () => {
    const onScrollAbove = vi.fn();
    const onScrollBelow = vi.fn();
    const ui = renderFeature(
      <WorkflowBody
        showSidebar={false}
        sidebarWidth={0}
        inputMode={normalInputMode()}
        reviewFilePath={null}
        contentHeight={REVIEW_MIN_ROWS}
        contentWidth={40}
        onScrollAbove={onScrollAbove}
        onScrollBelow={onScrollBelow}
      />,
    );

    onScrollAbove.mockClear();
    onScrollBelow.mockClear();
    ui.rerender(
      <WorkflowBody
        showSidebar={false}
        sidebarWidth={0}
        inputMode={reviewInputMode()}
        reviewFilePath="review.md"
        contentHeight={REVIEW_MIN_ROWS}
        contentWidth={40}
        onScrollAbove={onScrollAbove}
        onScrollBelow={onScrollBelow}
      />,
    );

    expect(onScrollAbove).toHaveBeenCalledWith('');
    expect(onScrollBelow).toHaveBeenCalledWith('');
    ui.unmount();
  });
});
