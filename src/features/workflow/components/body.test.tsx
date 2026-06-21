import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderFeature } from '#testing/helpers/ink.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { formatTasks } from '../../../engine/spec/formatter.js';
import { TASKS_FILE } from '../../../core/paths.js';
import { planEditorStore } from '../../../stores/workflow/plan-editor.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { activityStore } from '../../../stores/workflow/activity.js';
import { configStore } from '../../../stores/project/config.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { WorkflowBody } from './body.js';
import type { UseInputModeResult } from '../hooks/use-input-mode.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'workflow-body-test-'));
  eventsStore.__testReset();
  activityStore.__testReset();
  planEditorStore.__testReset();
  configStore.__testReset({ config: makeConfig(), projectDir: tmpDir });
});

afterEach(async () => {
  eventsStore.__testReset();
  activityStore.__testReset();
  planEditorStore.__testReset();
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

describe('WorkflowBody brief review rendering', () => {
  it('pads conversation content inside the main workflow body', () => {
    const ui = renderFeature(
      <WorkflowBody
        showSidebar={false}
        sidebarWidth={0}
        inputMode={normalInputMode()}
        reviewFilePath={null}
        phase="implementing"
        useRichEditor={false}
        contentHeight={4}
        contentWidth={40}
        terminalCols={80}
      />,
    );

    const frame = ui.lastFrame() ?? '';
    const row = frame.split('\n').find((line) => line.includes('No events yet')) ?? '';

    expect(row.startsWith(' ')).toBe(true);
    expect(row.trimStart()).toContain('No events yet');

    ui.unmount();
  });

  it('renders the rich plan editor when brief review opts into rich mode at runtime', async () => {
    const filePath = join(tmpDir, TASKS_FILE);
    await writeFile(filePath, formatTasks([makeTask({ id: 'T001', title: 'Rich body task' })]));

    const ui = renderFeature(
      <WorkflowBody
        showSidebar={false}
        sidebarWidth={0}
        inputMode={reviewInputMode()}
        reviewFilePath={filePath}
        phase="reviewing-briefs"
        useRichEditor
        contentHeight={24}
        contentWidth={120}
        terminalCols={140}
      />,
    );

    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain('tab sections');
    });
    expect(ui.lastFrame() ?? '').not.toContain('approve | e/edit');

    ui.unmount();
  });

  it.each([
    [120, 118],
    [140, 138],
  ])('shows the activity rail for wide %s-column runtime conversation layouts', (terminalCols, contentWidth) => {
    activityStore.__testReset({
      items: [
        {
          id: 'activity-1',
          callId: 'call-1',
          phase: 'implementing',
          role: 'implementer',
          stage: 'updated',
          kind: 'command',
          label: 'running npm test sk-abcdefghijklmnopqrstuvwxyz',
          target: 'npm test sk-abcdefghijklmnopqrstuvwxyz',
          runnerName: 'codex',
          redacted: true,
          rawAvailable: true,
          expandId: 'activity-1',
          sequence: 1,
          ts: 1,
        },
      ],
    });

    const ui = renderFeature(
      <WorkflowBody
        showSidebar={false}
        sidebarWidth={0}
        inputMode={normalInputMode()}
        reviewFilePath={null}
        phase="implementing"
        useRichEditor={false}
        contentHeight={5}
        contentWidth={contentWidth}
        terminalCols={terminalCols}
      />,
    );
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Activity 1');
    expect(frame).toContain('npm test sk-***');
    expect(frame).not.toContain('abcdefghijklmnopqrstuvwxyz');

    ui.unmount();
  });

  it.each([
    [80, 78],
    [100, 98],
  ])('hides the activity rail at %s columns', (terminalCols, contentWidth) => {
    activityStore.__testReset({
      items: [
        {
          id: 'activity-1',
          callId: 'call-1',
          phase: 'implementing',
          role: 'implementer',
          stage: 'updated',
          kind: 'command',
          label: 'running npm test',
          redacted: false,
          rawAvailable: false,
          expandId: 'activity-1',
          sequence: 1,
          ts: 1,
        },
      ],
    });

    const ui = renderFeature(
      <WorkflowBody
        showSidebar={false}
        sidebarWidth={0}
        inputMode={normalInputMode()}
        reviewFilePath={null}
        phase="implementing"
        useRichEditor={false}
        contentHeight={5}
        contentWidth={contentWidth}
        terminalCols={terminalCols}
      />,
    );

    expect(ui.lastFrame() ?? '').not.toContain('Activity 1');

    ui.unmount();
  });
});
