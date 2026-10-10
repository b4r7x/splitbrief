import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { getWorkflowPromptRows } from '../../src/features/workflow/prompt-rows/workflow.js';
import { approvalPromptStore } from '../../src/stores/approval-prompt/prompt.js';
import { configStore } from '../../src/stores/project/config.js';
import { questionPromptStore } from '../../src/stores/question-prompt/prompt.js';
import { controlsStore } from '../../src/stores/ui/controls.js';
import { terminalSizeStore } from '../../src/stores/ui/terminal-size.js';
import { eventsStore, mergeEventLog } from '../../src/stores/workflow/events.js';
import { operationsStore } from '../../src/stores/workflow/operations/state.js';
import { reviewStore } from '../../src/stores/workflow/review.js';
import { streamingOutputStore } from '../../src/stores/workflow/streaming-output.js';
import { stripTerminalControls } from '../../src/utils/display-text.js';
import { EngineEventSchema } from '../../src/engine/events/schema.js';
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
import { workflowFixtureRegistry } from './fixtures/workflow/registry.js';
import { mountGalleryScenario, type GalleryCaptureHandle } from './gallery/mount.js';

const VIEWPORT = viewport({ cols: 80, rows: 24 });

function lifecycleFor(scenarioId: ScenarioId): FixtureLifecycle {
  const factory = workflowFixtureRegistry.get(scenarioId);
  if (!factory) throw new Error(`Missing workflow fixture ${scenarioId}`);
  return factory();
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
  if (!checkpoint) throw new Error(`Missing workflow checkpoint ${projection.scenarioId}`);
  let ui: GalleryCaptureHandle | null = null;
  try {
    ui = await mountGalleryScenario({ scenario, checkpoint, viewport: VIEWPORT });
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
      expect(getWorkflowFixturePromptRows(projection, VIEWPORT.cols)).toBeGreaterThan(0);
    }
    return frame;
  } finally {
    await ui?.unmount();
  }
}

describe('workflow visual fixtures', () => {
  it.each(['workflow-review-task-cadence', 'workflow-review-task-cadence-settled'])(
    'renders %s with each review below its brief',
    async (id) => {
      const projection = workflowFixtureProjections.get(scenarioId(id));
      if (projection === undefined) throw new Error('Missing task cadence scenario');
      const frame = stripTerminalControls(await renderProjection(projection), {
        preserveLineBreaks: true,
      });
      const lines = frame.split('\n');
      const first = lines.findIndex((line) => line.includes('✓ T001'));
      const firstReview = lines.findIndex((line) => line.includes('✓ Review T001 passed'));
      const second = lines.findIndex((line) => line.includes('✓ T002'));
      expect(first).toBeGreaterThanOrEqual(0);
      expect(firstReview).toBe(first + 1);
      expect(second).toBe(firstReview + 1);
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
        expect(lines.filter((line) => line.includes('Review'))).toEqual(
          expect.arrayContaining([
            expect.stringContaining('✗ Review T002 failed  1 blocking · fixes T003 · 49.0s'),
            expect.stringContaining('✓ Review T002 passed  49.0s'),
            expect.stringContaining('✓ Review 1 passed  1m 2s'),
          ]),
        );
        expect(lines.filter((line) => line.includes('Review 1 passed'))).toHaveLength(1);
        expect(frame).not.toContain('running 0:');
      }
    },
  );

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
    expect(projection.events).toContainEqual(
      expect.objectContaining({
        type: 'warning',
        message:
          'BUILD seat changed OpenCode CLI · deepseek/deepseek-flash → OpenCode CLI · opencode-go/deepseek-v4.1-flash · high; the rest of the run uses the new seat',
      }),
    );
    const frame = stripTerminalControls(await renderProjection(projection)).replace(/\s+/g, ' ');
    expect(frame).toContain(
      'BUILD → OpenCode CLI · DeepSeek V4.1 Flash · high · Balance spent on OpenCode CLI',
    );
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
      'runner_call_error',
      'runner_call_activity',
      'error',
      'recovery_prompted',
      'recovery_action_selected',
      'seat_switched',
      'recovery_resolved',
      'warning',
      'task_started',
      'runner_call_started',
      'runner_call_tool_use',
      'runner_call_activity',
    ]);
    const calls = events.filter((event) => event.type.startsWith('runner_call_'));
    expect(calls.slice(0, 3)).toEqual(
      Array.from({ length: 3 }, () =>
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
    expect(calls.slice(3)).toEqual(
      Array.from({ length: 3 }, () =>
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
    expect(calls.at(-2)).toMatchObject({
      type: 'runner_call_tool_use',
      stage: 'delta',
      name: 'read',
      inputDelta: JSON.stringify({ path: 'src/endpoint.ts' }),
    });
    expect(calls.at(-1)).toMatchObject({
      type: 'runner_call_activity',
      kind: 'read',
      label: 'reading src/endpoint.ts',
      target: 'src/endpoint.ts',
    });
    const frame = stripTerminalControls(await renderProjection(projection)).replace(/\s+/g, ' ');
    expect(frame).toContain('OpenCode CLI · DeepSeek V4.1 Flash · high · working on T901');
    expect(frame).toContain('BUILD activity 1 update [OpenCode CLI · DeepSeek V4.1 Flash · high]');
    expect(frame).toContain('Read src/endpoint.ts');
    expect(frame).not.toContain('Between calls');
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
      expect(frame).not.toMatch(/DeepSeek[^\n]*· auto/);
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
        ui.stdin.write('\u001b[H');
        await new Promise((resolve) => setTimeout(resolve, 20));
        const reached: string[] = [];
        for (let row = 0; row < 12; row++) {
          reached.push(stripTerminalControls(ui.lastFrame() ?? '').replace(/\s+/g, ' '));
          ui.stdin.write('\u001b[1;2B');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(
          reached.some(
            (frame) =>
              frame.includes('BUILD → OpenCode CLI · DeepSeek V4.1 Flash · high') &&
              frame.includes('Balance spent on OpenCode CLI'),
          ),
        ).toBe(true);
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
          expect.objectContaining({ text: answer, qa: [{ question: 'Which store?', answer }] }),
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
    const projection = workflowFixtureProjections.get(scenarioId('workflow-review-base-mixed'));
    if (projection === undefined) throw new Error('Missing mixed base review scenario');
    const frame = stripTerminalControls(await renderProjection(projection));
    expect(frame).toContain('3/3 briefs passed');
    const review = frame.indexOf('Reviewer checks');
    for (const id of ['T001', 'T002', 'T003']) {
      const brief = frame.indexOf(`● ${id}`);
      expect(brief).toBeGreaterThanOrEqual(0);
      expect(brief).toBeLessThan(review);
    }
  });

  it('replays the completed briefs and the mid-step stop at T003 in the paused run', async () => {
    const projection = workflowFixtureProjections.get(scenarioId('workflow-at-rest-paused'));
    if (projection === undefined) throw new Error('Missing paused run scenario');
    const frame = stripTerminalControls(await renderProjection(projection));
    expect(frame).toContain('● T001');
    expect(frame).toContain('● T002');
    expect(frame).toContain('◉ T003 Add signup route tests');
    expect(frame).toContain('│ Stopped at T003');
    expect(frame).not.toContain('no events yet');
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
        const live = await ui.waitForCheckpoint();
        expect(live).toContain('Review · Reviewer check V2');
        ui.stdin.write('\u001b[H');
        await ui.waitForCheckpoint({
          predicate: ({ output }) => stripTerminalControls(output).includes('● Plan'),
        });
        const reached = [stripTerminalControls(ui.lastFrame() ?? '')];
        for (let row = 0; row < 10; row++) {
          ui.stdin.write('\u001b[1;2B');
          await new Promise((resolve) => setTimeout(resolve, 20));
          reached.push(stripTerminalControls(ui.lastFrame() ?? ''));
        }
        const history = reached.join('\n');
        expect(history).toContain('Review 1 failed');
        expect(history).toContain('fixes T904');
        expect(history).toContain('T904');
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

  // One render per projection: the walk grows with the gallery, so it gets the time a walk needs.
  it('renders every checkpoint through the production App without starting live work', {
    timeout: 60_000,
  }, async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    for (const projection of workflowFixtureProjections.values()) {
      await renderProjection(projection);
    }

    expect(fetch).not.toHaveBeenCalled();
  });

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
