import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderFeature, tick } from '#testing/helpers/ink.js';
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
        useRichEditor={false}
        contentHeight={8}
        contentWidth={80}
        terminalCols={100}
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

  it('resolves configured rich brief review rejection from the editor footer', async () => {
    const filePath = join(tmpDir, TASKS_FILE);
    await writeFile(filePath, formatTasks([makeTask({ id: 'T001', title: 'Rejectable task' })]));
    const inputMode = reviewInputMode();

    const ui = renderFeature(
      <WorkflowBody
        showSidebar={false}
        sidebarWidth={0}
        inputMode={inputMode}
        reviewFilePath={filePath}
        phase="reviewing-briefs"
        useRichEditor
        contentHeight={24}
        contentWidth={120}
        terminalCols={140}
      />,
    );
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain('N reject');
    });

    ui.stdin.write('N');
    await tick();

    expect(inputMode.resolve).toHaveBeenCalledWith({ approved: false });
    ui.unmount();
  });

  it('resolves flagged regeneration as revise feedback with the entered reason', async () => {
    const filePath = join(tmpDir, TASKS_FILE);
    await writeFile(
      filePath,
      formatTasks([
        makeTask({ id: 'T001', title: 'Split auth work', file: 'src/auth.ts' }),
        makeTask({ id: 'T002', title: 'Keep logging work', file: 'src/log.ts' }),
      ]),
    );
    const inputMode = reviewInputMode();

    const ui = renderFeature(
      <WorkflowBody
        showSidebar={false}
        sidebarWidth={0}
        inputMode={inputMode}
        reviewFilePath={filePath}
        phase="reviewing-briefs"
        useRichEditor
        contentHeight={24}
        contentWidth={120}
        terminalCols={140}
      />,
    );

    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain('Split auth work');
    });

    ui.stdin.write('x');
    ui.stdin.write('R');
    await tick();
    ui.stdin.write('too broad');
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(inputMode.resolve).toHaveBeenCalledWith(
        expect.objectContaining({
          approved: false,
          action: 'revise',
          comment: expect.stringContaining('User reason: too broad'),
        }),
      );
    });
    const result = vi.mocked(inputMode.resolve).mock.calls[0]?.[0];
    expect(typeof result === 'object' ? result.comment : '').toContain('T001');
    expect(typeof result === 'object' ? result.comment : '').not.toContain('T002');

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
    expect(frame).toContain('RUN');
    expect(frame).toContain('EDACTED***');
    expect(frame).toContain('raw');
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
