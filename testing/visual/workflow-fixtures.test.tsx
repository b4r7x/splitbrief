import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { getWorkflowPromptRows } from '../../src/features/workflow/prompt-rows/workflow.js';
import { approvalPromptStore } from '../../src/stores/approval-prompt/prompt.js';
import { configStore } from '../../src/stores/project/config.js';
import { questionPromptStore } from '../../src/stores/question-prompt/prompt.js';
import { controlsStore } from '../../src/stores/ui/controls.js';
import { terminalSizeStore } from '../../src/stores/ui/terminal-size.js';
import { eventsStore, mergeEventLog } from '../../src/stores/workflow/events.js';
import { lifecycleStore } from '../../src/stores/workflow/lifecycle.js';
import { operationsStore } from '../../src/stores/workflow/operations/state.js';
import { conversationScrollStore } from '../../src/stores/workflow/conversation-scroll.js';
import { readConversationScrollSnapshot } from '../../src/features/workflow/layout/snapshot.js';
import { flushEffects, tick } from '#testing/helpers/ink.js';
import { reviewStore } from '../../src/stores/workflow/review.js';
import { streamingOutputStore } from '../../src/stores/workflow/streaming-output.js';
import {
  selectRunningBrief,
  selectTaskListView,
  tasksStore,
} from '../../src/stores/workflow/tasks.js';
import { stripTerminalControls } from '../../src/utils/display-text.js';
import { EngineEventSchema } from '../../src/engine/events/schema.js';
import { deriveRunStatus } from '../../src/core/sessions/run-status.js';
import { findVisualScenario, REQUIRED_VIEWPORTS, WIDE_VIEWPORTS } from './catalog.js';
import { viewport } from './contracts/geometry.js';
import { scenarioId, type ScenarioId } from './contracts/identifiers.js';
import type { FixtureLifecycle } from './fixtures/common.js';
import { teardownVisualFixture } from './fixtures/screen-fixtures.js';
import {
  getWorkflowFixturePromptRows,
  workflowFixtureProjections,
  type WorkflowFixtureProjection,
} from './fixtures/workflow/projections.js';
import { workflowFixtureRegistry, workflowTranscriptText } from './fixtures/workflow/registry.js';
import { mountGalleryScenario, type GalleryCaptureHandle } from './gallery/mount.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';

const VIEWPORT = viewport({ cols: 80, rows: 24 });

it.each([
  'workflow-seat-switched',
  'workflow-seat-switched-manual',
  'workflow-seat-switched-balance',
])('finishes the restarted call and brief in %s', async (id) => {
  const projection = workflowFixtureProjections.get(scenarioId(id));
  if (projection === undefined) throw new Error(`Missing switch scenario ${id}`);
  const events = projection.events;
  const restart = events.findLastIndex((event) => event.type === 'runner_call_started');
  expect(events.slice(restart + 1).map((event) => event.type)).toEqual([
    'runner_call_tool_use',
    'runner_call_activity',
    'planner_text',
    'runner_call_completed',
    'implementer_generate_done',
    'task_completed',
  ]);
  expect(events.find((event) => event.type === 'implementer_generate_done')).toMatchObject({
    files: ['src/text.js', 'test/text.test.js'],
  });
  const lifecycle = await setupProjection(projection);
  try {
    expect(operationsStore.get().active).toBeNull();
    expect(selectRunningBrief(tasksStore.get(), lifecycleStore.get().phase).current).toBeNull();
    expect(tasksStore.get().tasks.filter((task) => task.status === 'done')).toHaveLength(1);
  } finally {
    await lifecycle.teardown();
  }
});

it.each(['queued', 'delivered', 'steerable'])(
  'uses one Claude Code BUILD seat in the %s queue fixture',
  (state) => {
    const projection = workflowFixtureProjections.get(
      scenarioId(`workflow-implementation-${state}`),
    );
    if (projection === undefined) throw new Error(`Missing ${state} queue fixture`);
    expect(projection.config?.implementer).toMatchObject({ kind: 'cli', tool: 'claude-code' });
    const call = projection.events.find((event) => event.type === 'runner_call_started');
    expect(call).toMatchObject({ backendKind: 'cli', runnerName: 'claude', taskId: 'T003' });
  },
);

it.each(['workflow-continuous-transcript', 'workflow-continuous-transcript-ready'])(
  'records the max effort on every started brief in %s',
  (id) => {
    const projection = workflowFixtureProjections.get(scenarioId(id));
    if (projection === undefined) throw new Error(`Missing scenario ${id}`);
    const starts = projection.events.filter((event) => event.type === 'task_started');
    expect(starts).toHaveLength(id === 'workflow-continuous-transcript' ? 3 : 2);
    for (const event of starts) expect(event.axes).toEqual(['max']);
  },
);

function lifecycleFor(scenarioId: ScenarioId): FixtureLifecycle {
  const factory = workflowFixtureRegistry.get(scenarioId);
  if (!factory) throw new Error(`Missing workflow fixture ${scenarioId}`);
  return factory();
}

async function scrollTranscript(
  ui: GalleryCaptureHandle,
  markers: readonly string[],
): Promise<string> {
  let snapshot = readConversationScrollSnapshot();
  while (snapshot.scrollOffset < snapshot.maxOffset) {
    ui.stdin.write('\u001b[5~');
    await tick(20);
    const next = readConversationScrollSnapshot();
    expect(next.scrollOffset).toBeGreaterThan(snapshot.scrollOffset);
    snapshot = next;
  }
  const reached = [stripTerminalControls(ui.lastFrame() ?? '', { preserveLineBreaks: true })];
  const rows = conversationScrollStore.get().scrollOffset;
  for (
    let row = 0;
    row < rows && !markers.every((marker) => reached.join('\n').includes(marker));
    row++
  ) {
    ui.stdin.write('\u001b[1;2B');
    await tick(20);
    reached.push(stripTerminalControls(ui.lastFrame() ?? '', { preserveLineBreaks: true }));
  }
  return reached.join('\n');
}

async function setupProjection(projection: WorkflowFixtureProjection): Promise<FixtureLifecycle> {
  const scenario = findVisualScenario(projection.scenarioId);
  if (!scenario) throw new Error(`Missing workflow scenario ${projection.scenarioId}`);
  const checkpoint = scenario.checkpoints[0];
  if (!checkpoint) throw new Error(`Missing workflow checkpoint ${projection.scenarioId}`);
  const lifecycle = lifecycleFor(projection.scenarioId);
  await lifecycle.setup({ scenario, checkpoint, viewport: VIEWPORT });
  return lifecycle;
}

async function renderProjection(projection: WorkflowFixtureProjection): Promise<string> {
  const scenario = findVisualScenario(projection.scenarioId);
  if (!scenario) throw new Error(`Missing workflow scenario ${projection.scenarioId}`);
  const checkpoint = scenario.checkpoints[0];
  const selectedViewport =
    scenario.viewports.find(
      (value) => value.cols === VIEWPORT.cols && value.rows === VIEWPORT.rows,
    ) ?? scenario.viewports[0];
  if (!checkpoint || !selectedViewport)
    throw new Error(`Missing workflow checkpoint or viewport ${projection.scenarioId}`);
  let ui: GalleryCaptureHandle | null = null;
  try {
    ui = await mountGalleryScenario({ scenario, checkpoint, viewport: selectedViewport });
    const frame = await ui.waitForCheckpoint();
    expect(controlsStore.get().inputMode).toBe(projection.inputMode);
    expect(controlsStore.get().sidebarVisible).toBe(projection.sidebarVisible);
    if (projection.atRest === undefined) {
      // A resumed halt republishes its own prompt through the recovery driver, so
      // that one event belongs to production, not to the projection's event list.
      const consultAnswer =
        projection.scenarioId === 'workflow-consult-answer-default' ||
        projection.scenarioId === 'workflow-consult-answer-typed';
      const drivenEvents =
        (projection.resumeState?.pendingRecovery === undefined ? 0 : 1) + (consultAnswer ? 1 : 0);
      expect(eventsStore.get().events).toHaveLength(
        mergeEventLog([...projection.events]).length + drivenEvents,
      );
    } else {
      // A run at rest stages no events: its transcript is its own history, and the replay
      // brackets whatever the run wrote with the two markers that say where it came from.
      const types = eventsStore.get().events.map((event) => event.type);
      expect(types[0], projection.scenarioId).toBe('replay_started');
      expect(types.at(-1), projection.scenarioId).toBe('replay_complete');
    }
    if (projection.review !== undefined) {
      // A document gate is its own panel; only the tiered gates go through the approval store.
      if (projection.reviewArtifact === undefined) {
        expect(approvalPromptStore.get().status).toBe('pending');
      }
      expect(questionPromptStore.get().hint).toBeNull();
      expect(getWorkflowFixturePromptRows(projection, selectedViewport.cols)).toBeGreaterThan(0);
    }
    return frame;
  } finally {
    await ui?.unmount();
  }
}

describe('workflow visual fixtures', () => {
  it('offers an inherited REVIEW its own seat and explains the switch', async () => {
    const projection = workflowFixtureProjections.get(scenarioId('workflow-recovery-review-seat'));
    if (projection === undefined) throw new Error('Missing inherited REVIEW recovery scenario');
    expect(projection.resumeState?.pendingRecovery).toMatchObject({
      seat: 'review',
      switchSeat: { seat: 'review' },
    });
    const frame = stripTerminalControls(await renderProjection(projection)).replace(/\s+/g, ' ');
    expect(frame).toContain('Change REVIEW tool');
    expect(frame).toContain('REVIEW uses PLAN. Switching here gives REVIEW its own seat.');
    expect(frame).not.toContain('Change PLAN tool');
  });

  it.each([
    ['workflow-recovery-no-fallback', 'no fallback set'],
    [
      'workflow-recovery-fallback-used',
      'fallback: OpenCode CLI · DeepSeek V4.1 Flash · automatic switch already used in this run',
    ],
    [
      'workflow-recovery-fallback-not-installed',
      'fallback: OpenCode CLI · DeepSeek V4.1 Flash · max · not offered: not installed',
    ],
  ])('renders the fallback detail and BUILD action for %s', async (id, detail) => {
    const scenario = findVisualScenario(id);
    const checkpoint = scenario?.checkpoints[0];
    const projection = workflowFixtureProjections.get(scenarioId(id));
    if (!scenario || !checkpoint || !projection) throw new Error(`Missing scenario ${id}`);
    const state = projection.resumeState;
    const issue = state?.pendingRecovery;
    expect(issue?.seat).toBe('build');
    expect(issue?.reason).toBe('runner-usage-limit');
    expect(issue?.details?.some((row) => row.includes(detail))).toBe(true);
    expect(issue?.switchSeat?.auto).toBeUndefined();
    if (id === 'workflow-recovery-no-fallback') {
      expect(projection.config?.implementer?.fallback).toBeUndefined();
    } else {
      expect(issue?.details?.some((row) => row.startsWith('fallback: '))).toBe(true);
    }
    if (id === 'workflow-recovery-fallback-used') {
      expect(state?.seatSwitches).toContainEqual(
        expect.objectContaining({ seat: 'build', auto: true }),
      );
    }
    if (id === 'workflow-recovery-fallback-not-installed') {
      expect(issue?.switchSeat?.candidates.some((candidate) => candidate.tool === 'opencode')).toBe(
        false,
      );
    }
    for (const renderViewport of REQUIRED_VIEWPORTS) {
      const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: renderViewport });
      try {
        const frame = stripTerminalControls(await ui.waitForCheckpoint(), {
          preserveLineBreaks: true,
        }).replace(/[│\s]+/g, ' ');
        expect(frame).toContain('Seat down');
        expect(frame).toContain('Change BUILD tool');
        if (renderViewport.rows >= 24) expect(frame).toContain(detail);
      } finally {
        await ui.unmount();
      }
    }
  });

  it.each([
    ['workflow-seat-switched', true],
    ['workflow-seat-switched-manual', false],
  ])('renders the recorded automatic flag for %s', async (id, auto) => {
    const scenario = findVisualScenario(id);
    const checkpoint = scenario?.checkpoints[0];
    const projection = workflowFixtureProjections.get(scenarioId(id));
    if (!scenario || !checkpoint || !projection) throw new Error(`Missing scenario ${id}`);
    expect(projection.events.find((event) => event.type === 'seat_switched')).toMatchObject({
      seat: 'build',
      auto,
    });
    for (const renderViewport of REQUIRED_VIEWPORTS) {
      const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: renderViewport });
      try {
        const frame = stripTerminalControls(await ui.waitForCheckpoint()).replace(/\s+/g, ' ');
        expect(frame).toContain('BUILD OpenCode CLI · deepseek/deepseek-flash');
        expect(frame).toContain('→ OpenCode CLI · opencode-go/deepseek-v4.1-flash · high');
        expect(frame.includes('automatic fallback')).toBe(auto);
        expect(frame).toContain('Balance spent on OpenCode CLI');
        expect(frame).not.toContain('usage limit');
      } finally {
        await ui.unmount();
      }
    }
  });

  it('replays the recorded spent-b2 warning and completions without file lists', async () => {
    const scenario = findVisualScenario('workflow-spent-b2-replay');
    const checkpoint = scenario?.checkpoints[0];
    const projection = workflowFixtureProjections.get(scenarioId('workflow-spent-b2-replay'));
    if (!scenario || !checkpoint || !projection) throw new Error('Missing spent-b2 replay');
    const record = projection.atRest?.record;
    if (record?.hydration.kind !== 'loaded') throw new Error('Missing spent-b2 saved state');
    expect(record.status).toEqual(
      deriveRunStatus({ state: record.hydration.state, liveness: 'not-alive' }),
    );
    expect(record.status).toMatchObject({
      kind: 'open',
      stop: { kind: 'stopped', on: { kind: 'paused', at: 'boundary' } },
      resumeAt: { kind: 'review', cycle: 0 },
    });
    expect(projection.events).toHaveLength(67);
    expect(projection.events.filter((event) => event.type === 'implementer_generate_done')).toEqual(
      [
        expect.objectContaining({ taskId: 'T001', file: 'src/text.js', duration: 15409 }),
        expect.objectContaining({ taskId: 'T002', file: 'src/preview.js', duration: 15018 }),
      ],
    );
    for (const event of projection.events.filter(
      (event) => event.type === 'implementer_generate_done',
    ))
      expect(event).not.toHaveProperty('files');
    expect(projection.events.find((event) => event.type === 'warning')?.message).toBe(
      'BUILD seat changed OpenCode CLI · deepseek/deepseek-flash → OpenCode CLI · opencode-go/deepseek-v4.1-flash · high; the rest of the run uses the new seat',
    );
    for (const renderViewport of scenario.viewports) {
      const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: renderViewport });
      try {
        const frame = stripAnsiStyles(await ui.waitForCheckpoint());
        const text = workflowTranscriptText();
        expect(text.match(/BUILD activity {2}5 updates/g)).toHaveLength(1);
        expect(text.match(/BUILD activity {2}4 updates/g)).toHaveLength(1);
        expect(text.match(/\+2 more · ctrl\+a/g)).toHaveLength(1);
        expect(text.match(/\+1 more · ctrl\+a/g)).toHaveLength(1);
        expect(frame).toContain('● Plan → × Build → ○ Review');
        if (renderViewport.cols === 200) expect(frame).toContain('Stopped before the review');
        expect(text.match(/Recovery {2}/g)).toHaveLength(1);
        for (const stale of [
          'Warning',
          'BUILD seat changed',
          'Add credit',
          'Change BUILD tool',
          'working on',
        ])
          expect(text).not.toContain(stale);
        expect(text.match(/Report {2}done · 2 files · 0 decisions/g)).toHaveLength(2);
        for (const name of ['text', 'preview']) {
          const line = text.split('\n').find((row) => row.startsWith(`src/${name}.js ·`));
          expect(line?.split(`src/${name}.js`)).toHaveLength(2);
          expect(line?.split(`test/${name}.test.js`)).toHaveLength(2);
        }
        expect(operationsStore.get().active).toBeNull();
        expect(selectTaskListView(tasksStore.get())).toMatchObject({ passed: 2, total: 2 });
      } finally {
        await ui.unmount();
      }
    }
  });

  it.each([120, 60])('expands and collapses recovery with ctrl+d at %s columns', async (cols) => {
    const scenario = findVisualScenario('workflow-seat-switched');
    const checkpoint = scenario?.checkpoints.find(
      (value) => value.id === 'seat-switched-expanded-recovery',
    );
    const renderViewport = scenario?.viewports.find((value) => value.cols === cols);
    if (!scenario || !checkpoint || !renderViewport) throw new Error('Missing expanded recovery');
    const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: renderViewport });
    try {
      await ui.waitForCheckpoint();
      expect(workflowTranscriptText()).toContain('provider.quota: Insufficient Balance');
      expect(workflowTranscriptText()).toContain('ctrl+d to collapse');
      ui.stdin.write('\u0004');
      await tick(20);
      expect(workflowTranscriptText()).not.toContain('provider.quota: Insufficient Balance');
      expect(workflowTranscriptText()).not.toContain('ctrl+d to collapse');
      expect(workflowTranscriptText().match(/Recovery {2}/g)).toHaveLength(1);
    } finally {
      await ui.unmount();
    }
  });

  it.each(WIDE_VIEWPORTS)(
    'counts out-of-scope task review notes at $cols x $rows',
    async (renderViewport) => {
      const scenario = findVisualScenario('workflow-review-task-out-of-scope');
      const checkpoint = scenario?.checkpoints[0];
      if (!scenario || !checkpoint) throw new Error('Missing out-of-scope review scenario');
      const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: renderViewport });
      try {
        const frame = stripTerminalControls(await ui.waitForCheckpoint(), {
          preserveLineBreaks: true,
        });
        const row = frame.split('\n').find((line) => line.includes('Review T001 passed'));
        expect(row).toContain('3 notes');
        expect(frame).not.toContain('0 notes');
      } finally {
        await ui.unmount();
      }
    },
  );

  it('models the smoke narration as marked chunks and retains the completed brief body', () => {
    const projection = workflowFixtureProjections.get(scenarioId('workflow-continuous-transcript'));
    if (!projection) throw new Error('Missing continuous transcript scenario');
    for (const event of projection.events)
      expect(EngineEventSchema.safeParse(event).success, event.type).toBe(true);
    const chunks = projection.events
      .filter((event) => event.type === 'planner_text')
      .filter((event) => event.role === 'implementer');
    expect(chunks.slice(0, 5).map((event) => event.text)).toEqual([
      'Implemented `lowStockItems` and `restockPlan` in',
      ' [src/report.js](file:///Users/x',
      '/.local/state/splitbrief/trees/42',
      '/run/src/report.js)',
      ' and added tests.\n',
    ]);
    for (const chunk of chunks) expect(chunk.content).toBe('markdown');
    expect(
      projection.events.filter(
        (event) => event.type === 'runner_call_activity' && event.taskId === 'T001',
      ),
    ).toHaveLength(5);
    const merged = mergeEventLog([...projection.events]);
    expect(merged).toContainEqual(
      expect.objectContaining({
        type: 'planner_text',
        role: 'implementer',
        text: expect.stringContaining('src/report.js) and added tests.'),
      }),
    );
  });

  it.each(REQUIRED_VIEWPORTS)(
    'keeps the completed body and running brief reachable at $cols x $rows',
    async (renderViewport) => {
      const scenario = findVisualScenario('workflow-continuous-transcript');
      const checkpoint = scenario?.checkpoints[0];
      if (!scenario || !checkpoint) throw new Error('Missing continuous transcript checkpoint');
      const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: renderViewport });
      try {
        const live = await ui.waitForCheckpoint();
        expect(live).toContain('npm test');
        const markers = [
          '● Plan',
          '● T001',
          'lowStockItems',
          '+2 more · ctrl+a',
          'Report  done',
          'Validate',
          'Fix check V1',
          'Keep the stock warning',
          '● T002',
          '◉ T003',
        ];
        const history = await scrollTranscript(ui, markers);
        for (const marker of markers) expect(history).toContain(marker);
        if (renderViewport.cols <= 120)
          expect(history.indexOf('● Plan')).toBeLessThan(history.indexOf('● T001'));
        expect(history.indexOf('● T001')).toBeLessThan(history.indexOf('lowStockItems'));
        expect(history).toContain('src/report.js');
        expect(history).not.toContain('](file:');
        expect(history).not.toContain('`lowStockItems`');
        expect(history).not.toContain('working on T001');
      } finally {
        await ui.unmount();
      }
    },
  );

  it.each(['workflow-review-task-cadence', 'workflow-review-task-cadence-settled'])(
    'renders %s with each review below its brief',
    async (id) => {
      const projection = workflowFixtureProjections.get(scenarioId(id));
      if (projection === undefined) throw new Error('Missing task cadence scenario');
      const scenario = findVisualScenario(id);
      const checkpoint = scenario?.checkpoints[0];
      if (scenario === undefined || checkpoint === undefined)
        throw new Error('Missing task cadence checkpoint');
      const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: VIEWPORT });
      try {
        const frame = stripTerminalControls(await ui.waitForCheckpoint(), {
          preserveLineBreaks: true,
        });
        const lines = workflowTranscriptText().split('\n');
        const first = lines.findIndex((line) => line.includes('● T001'));
        const firstReview = lines.findIndex((line) => line.includes('● Review T001 passed'));
        const second = lines.findIndex((line) => line.includes('● T002'));
        expect(first).toBeGreaterThanOrEqual(0);
        expect(firstReview).toBeGreaterThan(first);
        expect(second).toBeGreaterThan(firstReview);
        expect(lines.filter((line) => line.includes('Review T001 passed'))).toHaveLength(1);
        if (projection.atRest === undefined) {
          expect(frame).toContain('Review · Reviewer check V1 · npm test');
          expect(frame).toContain('Reviewer check V1');
          expect(frame).toContain('running 0:35');
          expect(
            projection.events.findLast((event) => event.type === 'review_started'),
          ).toMatchObject({
            scope: 'task',
            afterTaskId: 'T002',
            tool: 'codex',
            model: 'gpt-6.1-sol',
            axes: ['high'],
          });
        } else {
          expect(lines.filter((line) => /review/i.test(line))).toEqual(
            expect.arrayContaining([
              expect.stringContaining('✗ Review T002 failed  1 blocking · fixes T003 · 49.0s'),
              expect.stringContaining('● Review T002 passed  49.0s'),
              expect.stringContaining('● Final review passed  1m 2s'),
            ]),
          );
          expect(lines.filter((line) => line.includes('Final review passed'))).toHaveLength(1);
          expect(frame).not.toContain('running 0:');
        }
      } finally {
        await ui.unmount();
      }
    },
  );

  it.each([true, false])(
    'shows the narrow rail fraction only with the build block down %s',
    async (blockDown) => {
      const scenario = findVisualScenario('workflow-review-fix-narrow-rail');
      const checkpoint = scenario?.checkpoints[blockDown ? 1 : 0];
      const selectedViewport = scenario?.viewports[0];
      if (!scenario || !checkpoint || !selectedViewport)
        throw new Error('Missing narrow rail checkpoint');
      const handle = await mountGalleryScenario({
        scenario,
        checkpoint,
        viewport: selectedViewport,
      });
      try {
        const frame = stripTerminalControls(await handle.waitForCheckpoint());
        const rail = frame.split('\n')[0];
        if (blockDown) {
          expect(rail).toContain('● Build  4/7 passed');
          expect(frame).not.toContain('4/7 briefs passed');
        } else {
          expect(rail).toContain('● Build');
          expect(rail).not.toContain('4/7 passed');
          expect(frame).toContain('4/7 briefs passed');
        }
      } finally {
        await handle.unmount();
      }
    },
  );

  it.each(WIDE_VIEWPORTS)(
    'shows T006 running and T007 held back after a fix insertion at %s',
    async (viewport) => {
      const scenario = findVisualScenario('workflow-stop-sheet-fix-inserted');
      const checkpoint = scenario?.checkpoints[0];
      if (scenario === undefined || checkpoint === undefined)
        throw new Error('Missing inserted-fix scenario');
      const handle = await mountGalleryScenario({ scenario, checkpoint, viewport });
      try {
        const frame = stripTerminalControls(await handle.waitForCheckpoint())
          .replaceAll('│', '')
          .replace(/\s+/g, ' ');
        expect(frame).toContain('finish T006 including checks and review; do not start T007');
        expect(lifecycleStore.get().status).toBe('running');
        expect(eventsStore.get().events[0]?.type).toBe('workflow_started');
        expect(
          eventsStore.get().events.filter((event) => event.type === 'workflow_started'),
        ).toHaveLength(1);
        expect(tasksStore.get().tasks.map((task) => task.id)).toEqual([
          'T001',
          'T002',
          'T003',
          'T004',
          'T006',
          'T007',
          'T005',
        ]);
        expect(selectRunningBrief(tasksStore.get(), 'implementing')).toMatchObject({
          current: { id: 'T006' },
          next: { id: 'T007' },
        });
        expect(selectTaskListView(tasksStore.get())).toMatchObject({
          passed: 4,
          total: 7,
          unannounced: 0,
        });
        if (viewport.cols > 120) {
          expect(frame).toContain('Implement and test overdue book lookup');
          expect(frame).toContain('T007 Test overdue report boundari…');
          expect(frame).toContain('T005 Wire the library dashboard');
          expect(frame.indexOf('T007 Test overdue report boundari…')).toBeLessThan(
            frame.indexOf('T005 Wire the library dashboard'),
          );
        }
      } finally {
        await handle.unmount();
      }
    },
  );
  it('keeps the Build rail active while the pause menu names the running brief', async () => {
    const scenario = findVisualScenario('workflow-stop-menu-pause');
    const selectedViewport = scenario?.viewports.find((value) => value.cols === 160);
    const checkpoint = scenario?.checkpoints[0];
    if (scenario === undefined || selectedViewport === undefined || checkpoint === undefined)
      throw new Error('Missing pause menu scenario');
    const handle = await mountGalleryScenario({ scenario, viewport: selectedViewport, checkpoint });
    try {
      const frame = stripTerminalControls(await handle.waitForCheckpoint());
      expect(frame).toContain('● Build');
      expect(frame).toContain('finish T002');
      expect(frame).toContain('Tasks 1/3');
      expect(frame).toContain('● T001');
      expect(lifecycleStore.get().status).toBe('running');
    } finally {
      await handle.unmount();
    }
  });

  it.each([
    'workflow-stop-sheet',
    'workflow-stop-menu-parked',
    'workflow-stop-menu-quit-hint',
    'workflow-stop-menu-failed',
    'workflow-quit-hint',
    'workflow-stop-sheet-after-continue',
  ])('seeds T001 passing before T002 starts in %s', async (id) => {
    const scenario = findVisualScenario(id);
    const checkpoint = scenario?.checkpoints[0];
    const selectedViewport = scenario?.viewports[0];
    if (!scenario || !checkpoint || !selectedViewport) throw new Error(`Missing scenario ${id}`);
    const handle = await mountGalleryScenario({ scenario, checkpoint, viewport: selectedViewport });
    try {
      await handle.waitForCheckpoint();
      expect(selectTaskListView(tasksStore.get())).toMatchObject({ passed: 1, total: 3 });
      const events = eventsStore.get().events;
      const completedIndex = events.findIndex(
        (event) => event.type === 'task_completed' && event.taskId === 'T001',
      );
      const startedIndex = events.findIndex(
        (event) => event.type === 'task_started' && event.taskId === 'T002',
      );
      expect(completedIndex).toBeGreaterThan(0);
      expect(completedIndex).toBeLessThan(startedIndex);
    } finally {
      await handle.unmount();
    }
  });

  it.each(REQUIRED_VIEWPORTS)(
    'keeps plan and reviewer check rows after a ready verdict at $cols x $rows',
    async (renderViewport) => {
      const scenario = findVisualScenario('workflow-continuous-transcript-ready');
      const checkpoint = scenario?.checkpoints[0];
      if (!scenario || !checkpoint) throw new Error('Missing ready transcript checkpoint');
      const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: renderViewport });
      try {
        const frame = await ui.waitForCheckpoint();
        expect(frame).toContain('Apply');
        ui.stdin.write('\t');
        await flushEffects();
        const markers = [
          '● Plan',
          '● T001',
          '● T002',
          '● Final review passed',
          'Plan check K1',
          'Plan check K2',
          'Reviewer check V1',
        ];
        const history = await scrollTranscript(ui, markers);
        for (const marker of markers) expect(history).toContain(marker);
        expect(history.indexOf('● Final review passed')).toBeGreaterThan(
          history.indexOf('Reviewer check V1'),
        );
        expect(history).toContain('npm test · passed');
        expect(eventsStore.get().events.at(-1)?.type).toBe('replay_complete');
      } finally {
        await ui.unmount();
      }
    },
  );

  it.each(REQUIRED_VIEWPORTS)(
    'keeps file bundle content plain at $cols x $rows',
    async (renderViewport) => {
      const scenario = findVisualScenario('workflow-implementation-extracted-code');
      const checkpoint = scenario?.checkpoints[0];
      if (!scenario || !checkpoint) throw new Error('Missing extracted-code checkpoint');
      const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: renderViewport });
      try {
        const frame = stripTerminalControls(await ui.waitForCheckpoint(), {
          preserveLineBreaks: true,
        });
        expect(frame).toContain('Pending 2');
        if (renderViewport.cols === 60 && renderViewport.rows === 18) {
          expect(frame).toContain('Pending 2 · +1 more');
        } else {
          expect(frame).toContain('T903 Capture the bounded fixture frame');
        }
        const markers = ['file-bundle-v1', '__init__(*args)', '<!-- keep -->', '`code`'];
        const history = await scrollTranscript(ui, markers);
        for (const marker of markers)
          expect(history.replace(/\s/g, '')).toContain(marker.replace(/\s/g, ''));
      } finally {
        await ui.unmount();
      }
    },
  );

  it.each([
    ['workflow-implementation-narration', 'src/registry.ts'],
    ['workflow-implementation-adjacent-narration', 'src/fixture.ts'],
    ['workflow-implementation-fenced-handback', 'src/row.ts'],
  ])('renders marked implementer markdown in %s', async (id, label) => {
    const scenario = findVisualScenario(id);
    const checkpoint = scenario?.checkpoints[0];
    if (!scenario || !checkpoint) throw new Error(`Missing narration checkpoint ${id}`);
    const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: VIEWPORT });
    try {
      await ui.waitForCheckpoint();
      const markers = [label];
      if (id.endsWith('adjacent-narration')) markers.push('I run the two brief checks now.');
      if (id.endsWith('fenced-handback')) markers.push('Report  done');
      const history = await scrollTranscript(ui, markers);
      expect(history).toContain(label);
      expect(history).not.toContain('](file:');
      expect(history).not.toContain('`fixture`');
      if (id.endsWith('adjacent-narration')) {
        const messages = eventsStore.get().events.filter((event) => event.type === 'planner_text');
        expect(messages).toHaveLength(3);
        expect(messages[1]).toMatchObject({
          messageStart: true,
          text: 'The gallery has an uncommitted change.',
        });
        expect(history).toContain('I run the two brief checks now.');
      }
      if (id.endsWith('fenced-handback')) {
        expect(history).toContain('Report  done');
        expect(history).not.toContain('filesChanged');
      }
    } finally {
      await ui.unmount();
    }
  });

  it('keeps earlier brief boundary rows when the next brief starts', async () => {
    const scenario = findVisualScenario('workflow-completed-orphan-rows');
    const checkpoint = scenario?.checkpoints[0];
    if (!scenario || !checkpoint) throw new Error('Missing orphan-row checkpoint');
    const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: VIEWPORT });
    try {
      await ui.waitForCheckpoint();
      const markers = ['● T901', 'could not be read', 'also changed', '◉ T902'];
      const history = await scrollTranscript(ui, markers);
      for (const marker of markers) expect(history).toContain(marker);
    } finally {
      await ui.unmount();
    }
  });

  it('records the balance refusal, automatic switch, and restarted task with the fallback seat', async () => {
    const projection = workflowFixtureProjections.get(scenarioId('workflow-seat-switched-balance'));
    if (projection === undefined) throw new Error('Missing balance-switch scenario');
    for (const event of projection.events)
      expect(EngineEventSchema.safeParse(event).success).toBe(true);
    const switchIndex = projection.events.findIndex((event) => event.type === 'seat_switched');
    expect(projection.events[switchIndex]).toMatchObject({
      seat: 'build',
      from: { tool: 'opencode', model: 'deepseek/deepseek-flash' },
      to: { tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', variant: 'high' },
      cause: 'runner-usage-limit',
      accountCause: 'balance',
      headline: 'Balance spent on OpenCode CLI',
      auto: true,
    });
    expect(projection.config?.implementer).toMatchObject({
      tool: 'opencode',
      model: 'opencode-go/deepseek-v4.1-flash',
      variant: 'high',
      fallback: { tool: 'opencode', model: 'deepseek/deepseek-flash' },
    });
    expect(
      projection.events
        .filter((event) => event.type === 'task_started')
        .map((event) => event.lineageAttempt),
    ).toEqual([1, 1]);
    expect(projection.events.slice(switchIndex + 1)).toContainEqual(
      expect.objectContaining({
        type: 'task_started',
        tool: 'opencode',
        model: 'opencode-go/deepseek-v4.1-flash',
        axes: ['high'],
        backendKind: 'cli',
        implementerProfile: 'default',
      }),
    );
    expect(projection.events.filter((event) => event.type === 'warning')).toEqual([]);
    for (const event of projection.events.filter((event) => event.type === 'task_started')) {
      expect(event.files).toEqual(['src/text.js', 'test/text.test.js']);
    }
    const frame = stripTerminalControls(await renderProjection(projection)).replace(/\s+/g, ' ');
    expect(frame).toContain('BUILD OpenCode CLI · deepseek/deepseek-flash');
    expect(frame).toContain('→ OpenCode CLI · opencode-go/deepseek-v4.1-flash · high');
    expect(frame).toContain('automatic fallback');
    expect(frame).not.toContain('BUILD seat changed');
    expect(frame).not.toContain('Add credit');
    expect(frame).not.toContain('Change BUILD tool');
    expect(frame).not.toContain('BUILD failed');
    expect(frame).toContain('Balance spent on OpenCode CLI');
    expect(frame).not.toContain('usage limit');
    expect(frame).not.toContain('worker ');
    expect(frame).not.toContain('Workspace kept');
  });

  it('records the failed call, recovery prompt, and restarted fallback call in order', async () => {
    const projection = workflowFixtureProjections.get(scenarioId('workflow-seat-switched-balance'));
    if (projection === undefined) throw new Error('Missing balance-switch scenario');
    const events = projection.events;
    expect(events.map((event) => event.type)).toEqual([
      'workflow_started',
      'task_started',
      'runner_call_started',
      'runner_call_warning',
      'runner_call_activity',
      'runner_call_error',
      'runner_call_activity',
      'implementer_generate_failed',
      'error',
      'recovery_prompted',
      'recovery_action_selected',
      'seat_switched',
      'recovery_resolved',
      'task_started',
      'runner_call_started',
      'runner_call_tool_use',
      'runner_call_activity',
      'planner_text',
      'runner_call_completed',
      'implementer_generate_done',
      'task_completed',
    ]);
    const calls = events.filter((event) => event.type.startsWith('runner_call_'));
    expect(calls.slice(0, 5)).toEqual(
      Array.from({ length: 5 }, () =>
        expect.objectContaining({
          callId: 'visual-opencode-balance-failed',
          role: 'implementer',
          backendKind: 'cli',
          runnerName: 'opencode',
          model: 'deepseek/deepseek-flash',
          axes: [],
          attempt: 0,
          taskId: 'T901',
          usageBoundary: 'aggregate',
        }),
      ),
    );
    expect(calls.slice(5)).toEqual(
      Array.from({ length: 4 }, () =>
        expect.objectContaining({
          callId: 'visual-opencode-balance-restarted',
          role: 'implementer',
          backendKind: 'cli',
          runnerName: 'opencode',
          model: 'opencode-go/deepseek-v4.1-flash',
          axes: ['high'],
          attempt: 0,
          taskId: 'T901',
          usageBoundary: 'aggregate',
        }),
      ),
    );
    expect(calls.at(-3)).toMatchObject({
      type: 'runner_call_tool_use',
      stage: 'delta',
      name: 'read',
      inputDelta: JSON.stringify({ path: 'src/text.js' }),
    });
    expect(calls.at(-2)).toMatchObject({
      type: 'runner_call_activity',
      kind: 'read',
      label: 'reading src/text.js',
      target: 'src/text.js',
    });
    const frame = stripTerminalControls(await renderProjection(projection)).replace(/\s+/g, ' ');
    expect(calls.at(-1)).toMatchObject({ type: 'runner_call_completed', status: 'completed' });
    expect(frame).toContain('1/1 briefs passed');
    expect(frame).not.toContain('working on T901');
    expect(frame).toContain('BUILD activity 1 update [OpenCode CLI · DeepSeek V4.1 Flash · high]');
    expect(frame).toContain('Read src/text.js');
    expect(frame).not.toContain('attempt 2 of 8');
  });

  it('shows the fallback effort on the BUILD sidebar after a balance switch', async () => {
    const scenario = findVisualScenario('workflow-seat-switched-balance');
    const checkpoint = scenario?.checkpoints[0];
    const wide = scenario?.viewports.find((size) => size.cols === 160);
    if (!scenario || !checkpoint || !wide) throw new Error('Missing wide balance-switch scenario');
    const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: wide });
    try {
      const frame = stripTerminalControls(await ui.waitForCheckpoint(), {
        preserveLineBreaks: true,
      });
      const sidebar = frame
        .split('\n')
        .map((row) => row.trimStart())
        .filter((row) => row.startsWith('│'))
        .map((row) => row.slice(0, row.indexOf('│', 1) + 1))
        .join(' ');
      expect(sidebar).toContain('BUILD   OpenCode CLI');
      expect(sidebar).toContain('DeepSeek V4.1 Flash · high');
      expect(frame).toContain('Balance spent on OpenCode CLI');
      expect(frame).not.toContain('worker ');
      expect(sidebar).not.toMatch(/DeepSeek[^│]*· auto\b/);
      expect(frame).not.toMatch(/DeepSeek[^\n]*· auto\b/);
    } finally {
      await ui.unmount();
    }
  });

  it.each(WIDE_VIEWPORTS)(
    'keeps the balance switch reachable at $cols x $rows',
    async (renderViewport) => {
      const scenario = findVisualScenario('workflow-seat-switched-balance');
      const checkpoint = scenario?.checkpoints[0];
      if (!scenario || !checkpoint) throw new Error('Missing balance-switch scenario');
      const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: renderViewport });
      try {
        const frame = stripTerminalControls(await ui.waitForCheckpoint());
        expect(frame).not.toContain('worker ');
        expect(frame).not.toContain('Workspace kept');
        const markers = [
          'Recovery  Balance spent on OpenCode CLI',
          'BUILD  OpenCode CLI · deepseek/deepseek-flash',
          '→ OpenCode CLI · opencode-go/deepseek-v4.1-flash · high',
          'automatic fallback',
        ];
        const reached = await scrollTranscript(ui, markers);
        for (const marker of markers) expect(reached).toContain(marker);
        for (const stale of [
          'Add credit',
          'Change BUILD tool',
          'BUILD failed',
          'BUILD seat changed',
        ]) {
          expect(reached).not.toContain(stale);
        }
      } finally {
        await ui.unmount();
      }
    },
  );

  it.each(['default', 'typed'] as const)(
    'renders the %s consult answer beneath its question in the brief section',
    async (kind) => {
      const scenario = findVisualScenario(`workflow-consult-answer-${kind}`);
      const checkpoint = scenario?.checkpoints[0];
      if (!scenario || !checkpoint) throw new Error('Missing consult scenario');
      const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: VIEWPORT });
      try {
        const frame = stripTerminalControls(await ui.waitForCheckpoint());
        const answer = kind === 'default' ? 'memory' : 'redis';
        expect(
          ui
            .frameHistory()
            .some((frame) => stripTerminalControls(frame).includes('Question 1 of 1')),
        ).toBe(true);
        expect(frame.indexOf(`You → ${answer}`)).toBeGreaterThan(frame.indexOf('Which store?'));
        expect(frame.indexOf('Which store?')).toBeGreaterThan(frame.indexOf('T901'));
        expect(eventsStore.get().events.filter((event) => event.type === 'user_message')).toEqual([
          expect.objectContaining({
            text: `1. Which store?\n${answer}`,
            qa: [{ question: 'Which store?', answer }],
          }),
        ]);
        expect(frame).toContain(
          'PLAN · Claude Code CLI · Claude Sonnet 4 · answering the consult on T901',
        );
        expect(frame).toMatch(/last event \d+s ago/);
        expect(frame).not.toContain('no update yet');
        expect(operationsStore.get().byCallId.get('visual-consult-call-001')).toMatchObject({
          status: 'completed',
          role: 'planner',
          taskId: 'T901',
        });
      } finally {
        await ui.unmount();
      }
    },
  );

  it('no gallery fixture seeds final-review planner prose', () => {
    for (const projection of workflowFixtureProjections.values()) {
      expect(
        projection.events.filter(
          (event) => event.type === 'planner_text' && event.phase === 'final-review',
        ),
        projection.scenarioId,
      ).toHaveLength(0);
    }
  });

  it('drift fixtures contain no synthetic reviewer prose', async () => {
    for (const fixture of [
      { id: 'workflow-review-drift-clean', headline: 'Drift · clean' },
      {
        id: 'workflow-review-drift-found',
        headline: 'Drift · failed · 2 errors · 3 warnings',
      },
    ]) {
      const projection = workflowFixtureProjections.get(scenarioId(fixture.id));
      if (!projection) throw new Error(`Missing drift scenario ${fixture.id}`);
      expect(
        projection.events.filter(
          (event) => event.type === 'planner_text' && event.phase === 'final-review',
        ),
      ).toHaveLength(0);
      expect(projection.events).toContainEqual(
        expect.objectContaining({ type: 'review_checks', scope: 'final', status: 'planned' }),
      );
      expect(
        projection.events.filter((event) => event.type === 'full_suite' && event.status === 'done'),
      ).toHaveLength(4);
      expect(projection.events).toContainEqual(expect.objectContaining({ type: 'drift_report' }));

      const scenario = findVisualScenario(fixture.id);
      const checkpoint = scenario?.checkpoints[0];
      if (!scenario || !checkpoint) throw new Error(`Missing drift checkpoint ${fixture.id}`);
      for (const renderViewport of REQUIRED_VIEWPORTS) {
        const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: renderViewport });
        try {
          const frame = stripTerminalControls(await ui.waitForCheckpoint());
          expect(frame).toContain(fixture.headline);
        } finally {
          await ui.unmount();
        }
      }
    }
  });

  it('shows three completed briefs before the mixed base review checks', async () => {
    const scenario = findVisualScenario('workflow-review-base-mixed');
    const checkpoint = scenario?.checkpoints[0];
    if (!scenario || !checkpoint) throw new Error('Missing mixed base review scenario');
    const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: VIEWPORT });
    try {
      expect(stripAnsiStyles(await ui.waitForCheckpoint())).toContain('3/3 briefs passed');
      const frame = stripAnsiStyles(
        await scrollTranscript(ui, ['● T001', '● T002', '● T003', 'Reviewer checks']),
      );
      const review = frame.indexOf('Reviewer checks');
      for (const id of ['T001', 'T002', 'T003']) {
        const brief = frame.indexOf(`● ${id}`);
        expect(brief).toBeGreaterThanOrEqual(0);
        expect(brief).toBeLessThan(review);
      }
    } finally {
      await ui.unmount();
    }
  });

  it('replays the completed briefs and the mid-step stop at T003 in the paused run', async () => {
    const scenario = findVisualScenario('workflow-at-rest-paused');
    const checkpoint = scenario?.checkpoints[0];
    if (!scenario || !checkpoint) throw new Error('Missing paused run scenario');
    const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: VIEWPORT });
    try {
      const live = stripTerminalControls(await ui.waitForCheckpoint());
      expect(live).toContain('│ Stopped at T003');
      expect(live).not.toContain('no events yet');
      const markers = ['● T001', '● T002', '× T003 Add signup route tests'];
      const history = await scrollTranscript(ui, markers);
      for (const marker of markers) expect(history).toContain(marker);
      expect(history).not.toContain('working on');
    } finally {
      await ui.unmount();
    }
  });

  it('uses the production named-check warning with metadata and the additional-check count', () => {
    const projection = workflowFixtureProjections.get(scenarioId('workflow-recovery-plan-checks'));
    expect(projection?.events.find((event) => event.type === 'warning')).toMatchObject({
      message:
        'The plan failed check uncovered-criterion: Criterion C2 is served by no task (+1 more); it goes back to the planner once.',
      planCheck: { code: 'uncovered-criterion', message: 'Criterion C2 is served by no task.' },
    });
  });
  it.each(REQUIRED_VIEWPORTS)(
    'keeps the settled review and fix brief reachable by scrolling at $cols x $rows',
    async (renderViewport) => {
      const scenario = findVisualScenario('workflow-review-fix-cycles');
      const checkpoint = scenario?.checkpoints[0];
      if (!scenario || !checkpoint) throw new Error('Missing fix-cycle scenario');
      const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: renderViewport });
      try {
        const live = stripAnsiStyles(await ui.waitForCheckpoint());
        expect(live).toContain('Review · Reviewer check V2');
        const markers = ['● Plan', 'Final review failed', 'fixes T904', '● T904'];
        const history = await scrollTranscript(ui, markers);
        for (const marker of markers) expect(history).toContain(marker);
      } finally {
        await ui.unmount();
      }
    },
  );
  beforeEach(() => {
    forceUnicodeGlyphs();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    teardownVisualFixture();
  });

  it.each([...workflowFixtureProjections.values()])(
    'renders $scenarioId checkpoint through the production App without starting live work',
    async (projection) => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      await renderProjection(projection);
      expect(fetch).not.toHaveBeenCalled();
    },
    60_000,
  );

  it('initializes the requested viewport and resets prompt, review, event, and stream state', async () => {
    const review = workflowFixtureProjections.get(scenarioId('workflow-review'));
    const question = workflowFixtureProjections.get(scenarioId('workflow-question'));
    const implementation = workflowFixtureProjections.get(scenarioId('workflow-implementation'));
    const idle = workflowFixtureProjections.get(scenarioId('workflow-idle'));
    if (!review || !question || !implementation || !idle) {
      throw new Error('Missing required workflow projections');
    }

    const reviewSetup = await setupProjection(review);
    expect(approvalPromptStore.get().status).toBe('pending');
    expect(reviewStore.get().filePath).not.toBeNull();
    expect(questionPromptStore.get().hint).toBeNull();
    expect(controlsStore.get().inputMode).toBe('review');
    expect(getWorkflowFixturePromptRows(review, VIEWPORT.cols)).toBeGreaterThan(0);

    const implementationSetup = await setupProjection(implementation);
    expect(controlsStore.get().sidebarVisible).toBe(true);

    const questionSetup = await setupProjection(question);
    expect(approvalPromptStore.get().status).toBe('idle');
    expect(reviewStore.get().filePath).toBeNull();
    expect(questionPromptStore.get().hint).toBe(question.question?.prompt);
    expect(controlsStore.get().inputMode).toBe('question');

    const idleSetup = await setupProjection(idle);
    expect(configStore.get().config).not.toBeNull();
    expect(terminalSizeStore.get()).toMatchObject({ cols: 80, rows: 24, isSmall: true });
    expect(eventsStore.get().events).toEqual([]);
    expect(questionPromptStore.get().hint).toBeNull();
    expect(controlsStore.get().inputMode).toBe('normal');
    expect(controlsStore.get().sidebarVisible).toBe(false);
    expect(streamingOutputStore.get()).toMatchObject({ active: false, lines: [] });

    await reviewSetup.teardown();
    await implementationSetup.teardown();
    await questionSetup.teardown();
    await idleSetup.teardown();
  });

  it.each(WIDE_VIEWPORTS)(
    'keeps the current question and action hint inside $cols x $rows',
    async (renderViewport) => {
      const scenario = findVisualScenario('workflow-question');
      const checkpoint = scenario?.checkpoints[0];
      if (!scenario || !checkpoint) throw new Error('Missing question gallery checkpoint');
      const ui = await mountGalleryScenario({ scenario, checkpoint, viewport: renderViewport });
      try {
        const frame = stripTerminalControls(await ui.waitForCheckpoint(), {
          preserveLineBreaks: true,
        });
        expect(frame).toContain('Question 1 of 3');
        expect(frame).toContain('Which seat performs the per-slice review?');
        expect(frame).not.toContain('What should a');
        expect(frame).not.toContain('Where should sliced review live');
        expect(frame).toContain('tab');
        expect(frame.trimEnd().split('\n').length).toBeLessThanOrEqual(renderViewport.rows);
      } finally {
        await ui.unmount();
      }
    },
  );

  it('projects prompt rows from the same state rendered by the workflow fixture', async () => {
    const review = workflowFixtureProjections.get(scenarioId('workflow-review'));
    const question = workflowFixtureProjections.get(scenarioId('workflow-question'));
    const idle = workflowFixtureProjections.get(scenarioId('workflow-idle'));
    if (!review || !question || !idle) {
      throw new Error('Missing required prompt projections');
    }

    expect(getWorkflowFixturePromptRows(review, VIEWPORT.cols)).toBeGreaterThan(0);
    expect(getWorkflowFixturePromptRows(question, VIEWPORT.cols)).toBeGreaterThan(0);

    for (const projection of [review, question, idle]) {
      const lifecycle = await setupProjection(projection);
      const questionHint =
        controlsStore.get().inputMode === 'question' ? questionPromptStore.get().hint : null;
      expect(getWorkflowFixturePromptRows(projection, VIEWPORT.cols)).toBe(
        getWorkflowPromptRows({
          approvalState: approvalPromptStore.get(),
          questionHint,
          questions: questionPromptStore.get().questions,
          cols: VIEWPORT.cols,
        }),
      );
      await lifecycle.teardown();
    }
  });
});
