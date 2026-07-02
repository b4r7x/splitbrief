import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { configStore } from '../../../stores/project/config.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { WorkflowBody } from './body.js';
import type { UseInputModeResult } from '../hooks/use-input-mode.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'workflow-body-test-'));
  eventsStore.__testReset();
  configStore.__testReset({ config: makeConfig(), projectDir: tmpDir });
});

afterEach(async () => {
  eventsStore.__testReset();
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

describe('WorkflowBody brief review rendering', () => {
  it('renders conversation content flush against the terminal edge inside the main workflow body', () => {
    const ui = renderFeature(
      <WorkflowBody
        showSidebar={false}
        sidebarWidth={0}
        inputMode={normalInputMode()}
        reviewFilePath={null}
        phase="implementing"
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
        phase="implementing"
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

  it('keeps the conversation visible in question mode (the prompt panel lives above the composer)', () => {
    const ui = renderFeature(
      <WorkflowBody
        showSidebar={false}
        sidebarWidth={0}
        inputMode={questionInputMode('Task interrupted. Enter instructions to continue:')}
        reviewFilePath={null}
        phase="implementing"
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
        phase="implementing"
        contentHeight={4}
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
        reviewFilePath={null}
        phase="implementing"
        contentHeight={4}
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
