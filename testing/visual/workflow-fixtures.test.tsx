import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { getWorkflowPromptRows } from '../../src/features/workflow/prompt-rows/workflow.js';
import { approvalPromptStore } from '../../src/stores/approval-prompt/prompt.js';
import { configStore } from '../../src/stores/project/config.js';
import { questionPromptStore } from '../../src/stores/question-prompt/prompt.js';
import { controlsStore } from '../../src/stores/ui/controls.js';
import { terminalSizeStore } from '../../src/stores/ui/terminal-size.js';
import { eventsStore, mergeEventLog } from '../../src/stores/workflow/events.js';
import { reviewStore } from '../../src/stores/workflow/review.js';
import { streamingOutputStore } from '../../src/stores/workflow/streaming-output.js';
import { stripTerminalControls } from '../../src/utils/display-text.js';
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
      } finally {
        await ui.unmount();
      }
    },
  );

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
          predicate: ({ output }) => stripTerminalControls(output).includes('✓ Plan'),
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
