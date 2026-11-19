import { afterEach, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { renderThroughFilteredStdin } from '#testing/helpers/filtered-stdin-harness.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { WorkflowScreen } from '../../../src/app/screens/workflow.js';
import { taskId } from '../../../src/core/schemas/task.js';
import { appendEngineEvent } from '../../../src/core/sessions/log/writer.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import { readRunHistory } from '../../../src/features/workflow/run-history.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { configStore } from '../../../src/stores/project/config.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import { addEvent } from '../../../src/stores/workflow/actions/event.js';

const VIEWPORT = { cols: 120, rows: 40 };
const checks = Array.from(
  { length: 6 },
  (_, index): EngineEvent => ({
    type: 'full_suite',
    ts: index,
    phase: 'final-review',
    status: 'done',
    id: `K${index + 1}`,
    command: 'test -f README.md',
    moment: 'pre-review',
    passed: true,
  }),
);
const diff: EngineEvent = {
  type: 'implementer_generate_done',
  ts: 0,
  phase: 'implementing',
  taskId: taskId('T001'),
  file: 'README.md',
  diff: '+ added line\n- removed line',
  linesAdded: 1,
  linesRemoved: 1,
  duration: 100,
};
const reviewPassed: EngineEvent = {
  type: 'review_completed',
  ts: 10,
  phase: 'final-review',
  scope: 'final',
  tool: 'claude-code',
  verdict: 'pass',
  duration: 5,
};
afterEach(resetAllStores);

it.each([
  {
    fold: 'the final review checks',
    events: checks,
    key: '\x01',
    collapsed: /\+6 checks · ctrl\+a/u,
    expanded: 'collapse · ctrl+a',
  },
  {
    fold: 'the diff',
    events: [diff],
    key: '\x04',
    collapsed: /README\.md\s+\+1 -1\s+ctrl\+d/u,
    expanded: '+ added line',
  },
])('keeps $fold open when the ready run reloads its log', async (test) => {
  await withTempDir('workflow-fold-replay', async (projectDir) => {
    resetAllStores();
    configStore.__testReset({ config: makeConfig(), projectDir });
    terminalSizeStore.__testReset(VIEWPORT);
    const run = makeRunRecord({
      ref: { projectDir, sessionId: '2026-11-19-review' },
      status: { kind: 'ready-to-apply', override: false },
      hydration: {
        kind: 'loaded',
        state: makeWorkflowState({ phase: 'complete', reviewStatus: 'passed' }),
      },
    });
    for (const event of [...test.events, reviewPassed]) {
      appendEngineEvent(run.ref, event);
      addEvent(event);
    }
    // With no saved state to trigger an automatic refresh, the test controls publication.
    const publish = await readRunHistory(run);
    routerStore.init({ screen: 'workflow', run, execution: { kind: 'at-rest' } });
    const ui = renderThroughFilteredStdin(
      <WorkflowScreen commands={[]} onRuntimeCommand={() => {}} />,
      VIEWPORT,
    );
    try {
      await expect.poll(ui.lastFrame).toMatch(/[▌|] Apply ·/u);
      await expect.poll(ui.lastFrame).toContain('Final review passed');
      expect(ui.lastFrame()).toMatch(test.collapsed);

      ui.pressBytes(test.key);
      await expect.poll(ui.lastFrame).toContain(test.expanded);

      publish();
      // The selection change gives us a frame painted after publication.
      ui.pressBytes('\x1b[B');
      await expect.poll(ui.lastFrame).toMatch(/[▌|] Show diff ·/u);
      expect(ui.lastFrame(), 'The fold is still open after the log replay').toContain(
        test.expanded,
      );
    } finally {
      ui.unmount();
    }
  });
});
