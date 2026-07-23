import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { renderFeature, type RenderFeatureResult, tick } from '#testing/helpers/ink.js';
import { App } from '../../src/app/root.js';
import { approvalPromptStore } from '../../src/stores/approval-prompt/prompt.js';
import { configStore } from '../../src/stores/project/config.js';
import { questionPromptStore } from '../../src/stores/question-prompt/prompt.js';
import { controlsStore } from '../../src/stores/ui/controls.js';
import { terminalSizeStore } from '../../src/stores/ui/terminal-size.js';
import { eventsStore, projectEventForTuiEventLog } from '../../src/stores/workflow/events.js';
import { reviewStore } from '../../src/stores/workflow/review.js';
import { streamingOutputStore } from '../../src/stores/workflow/streaming-output.js';
import { findVisualScenario } from './catalog.js';
import { viewport } from './contracts/geometry.js';
import { scenarioId, type ScenarioId } from './contracts/identifiers.js';
import type { FixtureLifecycle } from './fixtures/common.js';
import { teardownVisualFixture } from './fixtures/screen-fixtures.js';
import {
  workflowFixtureProjections,
  type WorkflowFixtureProjection,
} from './fixtures/workflow/projections.js';
import { createWorkflowFixtureAppDeps } from './fixtures/workflow/setup.js';
import {
  workflowCheckpointPredicates,
  workflowFixtureRegistry,
} from './fixtures/workflow/registry.js';

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
  const lifecycle = lifecycleFor(projection.scenarioId);
  let ui: RenderFeatureResult | null = null;
  try {
    await lifecycle.setup({ scenario, checkpoint, viewport: VIEWPORT });
    ui = renderFeature(<App workflowDeps={createWorkflowFixtureAppDeps(projection)} />);
    await tick(20);
    const frame = ui.lastFrame() ?? '';
    const predicate = workflowCheckpointPredicates.get(checkpoint.id);
    expect(predicate, projection.scenarioId).toBeDefined();
    expect(
      predicate?.({ output: frame, scenario, checkpoint }),
      `${projection.scenarioId}: ${checkpoint.marker}`,
    ).toBe(true);
    expect(controlsStore.get().inputMode).toBe(projection.inputMode);
    expect(eventsStore.get().events).toHaveLength(
      projection.events.filter((event) => projectEventForTuiEventLog(event) !== null).length,
    );
    return frame;
  } finally {
    ui?.unmount();
    await lifecycle.teardown();
  }
}

describe('workflow visual fixtures', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    teardownVisualFixture();
  });

  it('renders every checkpoint through the production App without starting live work', async () => {
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
    const idle = workflowFixtureProjections.get(scenarioId('workflow-idle'));
    if (!review || !question || !idle) throw new Error('Missing required workflow projections');

    const reviewSetup = await setupProjection(review);
    expect(approvalPromptStore.get().status).toBe('pending');
    expect(reviewStore.get().filePath).not.toBeNull();

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
    expect(streamingOutputStore.get()).toMatchObject({ active: false, lines: [] });

    await reviewSetup.teardown();
    await questionSetup.teardown();
    await idleSetup.teardown();
  });
});
