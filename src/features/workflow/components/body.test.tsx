import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderFeature } from '#testing/helpers/ink.js';
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
  it('pads conversation content inside the main workflow body', () => {
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
    const row = lines.find((line) => line.includes('No events yet')) ?? '';

    expect(lines[0]).toBe('');
    expect(row.startsWith(' ')).toBe(true);
    expect(row.trimStart()).toContain('No events yet');

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
    expect(frame).toContain('No events yet');

    ui.unmount();
  });

  it('renders question prompts as a sanitized multiline body surface', () => {
    const rawToken = 'abcdefghijklmnopqrstuvwxyz1234567890abcdef';
    const ui = renderFeature(
      <WorkflowBody
        showSidebar={false}
        sidebarWidth={0}
        inputMode={questionInputMode(
          [
            'Task review: T001 - Run command',
            'Validation: npm test \u001b]52;c;clipboard\u0007token=' + rawToken,
            '',
            'Commands: continue, redo, notes <text>, abort',
          ].join('\n'),
        )}
        reviewFilePath={null}
        phase="implementing"
        contentHeight={8}
        contentWidth={80}
      />,
    );

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Task review: T001 - Run command');
    expect(frame).toContain('Validation: npm test token=***REDACTED***');
    expect(frame).toContain('Commands: continue, redo, notes <text>, abort');
    expect(frame).not.toContain(rawToken);
    expect(frame).not.toContain('clipboard');
    expect(frame).not.toContain('\u001b');

    ui.unmount();
  });

  it('clears the above-scroll label when conversation mode is replaced by a prompt', () => {
    const onScrollAbove = vi.fn();
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
      />,
    );

    onScrollAbove.mockClear();
    ui.rerender(
      <WorkflowBody
        showSidebar={false}
        sidebarWidth={0}
        inputMode={questionInputMode('Question?')}
        reviewFilePath={null}
        phase="implementing"
        contentHeight={4}
        contentWidth={40}
        onScrollAbove={onScrollAbove}
      />,
    );

    expect(onScrollAbove).toHaveBeenCalledWith('');
    ui.unmount();
  });
});
