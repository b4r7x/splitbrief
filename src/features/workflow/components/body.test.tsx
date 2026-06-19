import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderFeature } from '#testing/helpers/ink.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { formatTasks } from '../../../engine/spec/formatter.js';
import { TASKS_FILE } from '../../../core/paths.js';
import { planEditorStore } from '../../../stores/workflow/plan-editor.js';
import { configStore } from '../../../stores/project/config.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { WorkflowBody } from './body.js';
import type { UseInputModeResult } from '../hooks/use-input-mode.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'workflow-body-test-'));
  planEditorStore.__testReset();
  configStore.__testReset({ config: makeConfig(), projectDir: tmpDir });
});

afterEach(async () => {
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
        sections={[]}
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
        sections={[]}
      />,
    );

    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain('tab sections');
    });
    expect(ui.lastFrame() ?? '').not.toContain('approve | e/edit');

    ui.unmount();
  });
});
