import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { renderFeature, type RenderFeatureResult, tick } from '#testing/helpers/ink.js';
import { App } from '../../src/app/root.js';
import { BRIEF_QUALITY_FILE, STATE_FILE, TASKS_FILE } from '../../src/core/paths.js';
import { WorkflowStateSchema } from '../../src/core/schemas/workflow.js';
import { parseTasksStrict } from '../../src/engine/spec/tasks/parse.js';
import { getWorkflowPromptRows } from '../../src/features/workflow/prompt-rows/workflow.js';
import { approvalPromptStore } from '../../src/stores/approval-prompt/prompt.js';
import { costApprovalStore } from '../../src/stores/cost-approval/prompt.js';
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
import { teardownVisualFixture, VISUAL_FIXTURE_PROJECT_DIR } from './fixtures/screen-fixtures.js';
import {
  getWorkflowFixturePromptRows,
  workflowFixtureProjections,
  type WorkflowFixtureProjection,
} from './fixtures/workflow/projections.js';
import { persistedBriefRecoveryFixture } from './fixtures/workflow/persisted-brief-recovery.js';
import {
  createWorkflowFixtureAppDeps,
  createWorkflowFixtureFactory,
} from './fixtures/workflow/setup.js';
import { enterCaptureEnvironment } from './gallery/environment.js';
import { waitForCheckpoint } from './gallery/checkpoints.js';
import {
  workflowCheckpointPredicates,
  workflowFixtureRegistry,
} from './fixtures/workflow/registry.js';
import { LOCATOR_REGISTRY } from './locators/registry.js';

const VIEWPORT = viewport({ cols: 80, rows: 24 });
const RECOVERY_FIXTURE_IDS = [
  scenarioId('workflow-brief-recovery-zero-task-blocked'),
  scenarioId('workflow-brief-recovery-storage-blocked'),
  scenarioId('workflow-brief-recovery-task-blocked'),
  scenarioId('workflow-brief-recovery-retrying-queued'),
  scenarioId('workflow-brief-recovery-unresolved'),
  scenarioId('workflow-brief-recovery-ready'),
  scenarioId('workflow-brief-recovery-provider-failed'),
  scenarioId('workflow-brief-recovery-budget-blocked'),
] as const;

const RECOVERY_PROFILES = [
  { name: 'unicode-color', viewport: viewport({ cols: 121, rows: 16 }) },
  { name: 'unicode-mono', viewport: viewport({ cols: 120, rows: 16 }) },
  { name: 'ascii-mono', viewport: viewport({ cols: 119, rows: 16 }) },
] as const;
const ANSI_CONTROL_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'gu');

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
    if (predicate === undefined) {
      throw new Error(`Missing workflow checkpoint predicate ${checkpoint.id}`);
    }
    expect(
      predicate({ output: frame, scenario, checkpoint }),
      `${projection.scenarioId}: ${checkpoint.marker}`,
    ).toBe(true);
    expect(controlsStore.get().inputMode).toBe(projection.inputMode);
    expect(controlsStore.get().sidebarVisible).toBe(projection.sidebarVisible);
    expect(eventsStore.get().events).toHaveLength(
      projection.events.filter((event) => projectEventForTuiEventLog(event) !== null).length,
    );
    if (projection.review !== undefined) {
      expect(approvalPromptStore.get().status).toBe('pending');
      expect(questionPromptStore.get().hint).toBeNull();
      expect(getWorkflowFixturePromptRows(projection, VIEWPORT.cols)).toBeGreaterThan(0);
    }
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
          costApprovalState: costApprovalStore.get(),
          questionHint,
          cols: VIEWPORT.cols,
        }),
      );
      await lifecycle.teardown();
    }
  });

  it('registers every recovery scenario with locators for its declared elements', () => {
    const registeredIds = new Set<ScenarioId>(workflowFixtureRegistry.keys());
    expect([...RECOVERY_FIXTURE_IDS].every((id) => registeredIds.has(id))).toBe(true);

    for (const recoveryScenarioId of RECOVERY_FIXTURE_IDS) {
      const scenario = findVisualScenario(recoveryScenarioId);
      if (!scenario) throw new Error(`Missing recovery scenario ${recoveryScenarioId}`);
      const declaredElements = scenario.elements.map((element) => element.id);
      for (const element of declaredElements) {
        expect(
          LOCATOR_REGISTRY[`workflow:${element}`],
          `${recoveryScenarioId}/${element}`,
        ).toBeDefined();
      }
      expect(
        declaredElements.find((element) => /(?:composer|input)/iu.test(element)),
        `${recoveryScenarioId} stable input element`,
      ).toBeDefined();
      expect(
        declaredElements.find((element) => /(?:action|now)/iu.test(element)),
        `${recoveryScenarioId} action element`,
      ).toBeDefined();
      expect(
        declaredElements.find((element) => /(?:because|cause)/iu.test(element)),
        `${recoveryScenarioId} cause element`,
      ).toBeDefined();
    }
  });

  it('renders persisted blocked authority over the contradictory zero-task and 0.80 legacy projections', async () => {
    const fixture = persistedBriefRecoveryFixture();
    const scenario = findVisualScenario(fixture.scenarioId);
    if (!scenario) throw new Error(`Missing persisted recovery scenario ${fixture.scenarioId}`);
    const checkpoint = scenario.checkpoints[0];
    if (!checkpoint) throw new Error(`Missing persisted recovery checkpoint ${fixture.scenarioId}`);
    const profile = RECOVERY_PROFILES[0];
    const environment = enterCaptureEnvironment({
      viewport: profile.viewport,
      profile: profile.name,
    });
    const lifecycle = createWorkflowFixtureFactory(fixture)();
    let ui: RenderFeatureResult | null = null;
    try {
      await lifecycle.setup({ scenario, checkpoint, viewport: profile.viewport });

      const sessionDir = join(
        VISUAL_FIXTURE_PROJECT_DIR,
        '.splitbrief',
        'sessions',
        'visual-workflow',
      );
      const persistedState = WorkflowStateSchema.parse(
        JSON.parse(await readFile(join(sessionDir, STATE_FILE), 'utf8')),
      );
      expect(persistedState.briefRecovery?.status).toBe('blocked');
      expect(parseTasksStrict(await readFile(join(sessionDir, TASKS_FILE), 'utf8'))).toEqual([]);
      const legacyQualityText = await readFile(join(sessionDir, BRIEF_QUALITY_FILE), 'utf8');
      expect(JSON.parse(legacyQualityText)).toEqual(fixture.legacyQuality);
      expect(legacyQualityText).toContain('"score":0.8');

      ui = renderFeature(
        <App workflowDeps={createWorkflowFixtureAppDeps(fixture)} />,
        profile.viewport,
      );
      const frame = await waitForCheckpoint({
        scenario,
        checkpoint,
        viewport: profile.viewport,
        lastFrame: ui.lastFrame,
      });
      const plainFrame = frame.replace(ANSI_CONTROL_SEQUENCE, '');
      expect(plainFrame, fixture.scenarioId).toContain('CONTRACT BLOCKED');
      expect(plainFrame, fixture.scenarioId).toContain('BECAUSE');
      expect(plainFrame, fixture.scenarioId).toContain('NOW');
      expect(plainFrame, fixture.scenarioId).toMatch(/(?:Retry|Edit|Reject)/iu);
      expect(plainFrame, fixture.scenarioId).not.toContain('quality 0.80');
    } finally {
      ui?.unmount();
      await lifecycle.teardown();
      environment.restore();
    }
  });
});
