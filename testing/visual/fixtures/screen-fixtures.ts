import { mkdirSync, rmSync } from 'node:fs';
import type { RouteData } from '../../../src/stores/navigation/router.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { configStore } from '../../../src/stores/project/config.js';
import { detectionStore } from '../../../src/stores/project/detection.js';
import { questionPromptStore } from '../../../src/stores/question-prompt/prompt.js';
import { completionStore } from '../../../src/stores/ui/completion.js';
import { editorStore } from '../../../src/stores/ui/editor.js';
import { externalEditRequestStore } from '../../../src/stores/ui/external-edit-request.js';
import { projectFilesStore } from '../../../src/stores/ui/project-files.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import { resetWorkflow } from '../../../src/stores/workflow/actions/reset.js';
import { operationsStore } from '../../../src/stores/workflow/operations/state.js';
import type { DetectionServiceResult } from '../../../src/engine/detection/service.js';
import { scenarioId } from '../contracts/identifiers.js';
import { makeConfig } from '../../helpers/factories/config.js';
import { cliDetectionFor } from '../../helpers/factories/detection.js';
import { makeSummary } from '../../helpers/factories/summary.js';
import { resetAllStores } from '../../helpers/stores.js';
import { prepareWorkflowExecution } from '../../helpers/workflow-screen.js';
import type {
  FixtureContext,
  FixtureFactory,
  FixtureLifecycle,
  FixtureRegistry,
} from './common.js';

const VISUAL_FIXTURE_WORK_DIR = `.test-artifacts/ui-fixture-worker-${process.pid}`;
export const VISUAL_FIXTURE_PROJECT_DIR = `${VISUAL_FIXTURE_WORK_DIR}/ui-fixture-project`;

function visualConfig() {
  return makeConfig({
    planner: {
      kind: 'cli',
      tool: 'claude-code',
      model: 'claude-sonnet-4',
    },
    implementer: {
      kind: 'api',
      provider: 'ollama',
      model: 'qwen2.5-coder:7b',
      apiBase: 'http://127.0.0.1:11434/v1',
      contextLength: 32_768,
      temperature: 0.2,
    },
    workflow: {
      mode: 'standard',
      persistTranscript: false,
      maxRetries: 2,
    },
  });
}

export function resetVisualFixtureStores(): void {
  resetAllStores();
  resetWorkflow();
  operationsStore.reset();
  editorStore.reset();
  questionPromptStore.reset();
  externalEditRequestStore.reset();
  completionStore.reset();
  projectFilesStore.reset();
}

export function setupVisualFixture(context: FixtureContext): void {
  removeFixtureProject();
  mkdirSync(VISUAL_FIXTURE_PROJECT_DIR, { recursive: true });
  resetVisualFixtureStores();
  const config = visualConfig();
  configStore.__testReset({
    config,
    diskConfig: config,
    projectDir: VISUAL_FIXTURE_PROJECT_DIR,
  });
  terminalSizeStore.__testReset({
    cols: context.viewport.cols,
    rows: context.viewport.rows,
    isSmall: context.viewport.cols < 120,
  });
}

export function teardownVisualFixture(): void {
  resetVisualFixtureStores();
  removeFixtureProject();
}

function removeFixtureProject(): void {
  rmSync(VISUAL_FIXTURE_WORK_DIR, { recursive: true, force: true });
}

function createRouteFixture(route: () => RouteData): FixtureLifecycle {
  return {
    setup: (context) => {
      setupVisualFixture(context);
      routerStore.init(route());
    },
    teardown: teardownVisualFixture,
  };
}

export const createHomeFixture: FixtureFactory = () =>
  createRouteFixture(() => ({ screen: 'home' }));

export function createWorkflowBaseFixture(
  feature = 'Refine terminal navigation',
): FixtureLifecycle {
  return createRouteFixture(() => {
    const config = configStore.get().config;
    if (config === null) throw new Error('Visual workflow fixture requires project config');
    const prepared = prepareWorkflowExecution({
      projectDir: VISUAL_FIXTURE_PROJECT_DIR,
      feature,
      config,
      sessionId: 'visual-workflow',
    });
    return {
      screen: 'workflow',
      execution: { kind: 'local', prepared },
    };
  });
}

export const createSummaryFixture: FixtureFactory = () =>
  createRouteFixture(() => ({
    screen: 'summary',
    sessionId: 'visual-summary',
    status: 'complete',
    summary: makeSummary({
      feature: 'Visual fixture workflow complete',
      totalTasks: 4,
      completedByLocal: 3,
      escalatedToPlanner: 1,
      totalTime: 82_000,
      estimatedCostSavings: '$4.80',
      escalationRate: 0.25,
      plannerTool: 'claude-code',
      plannerModel: 'claude-sonnet-4',
      implementerTool: 'ollama',
      implementerModel: 'qwen2.5-coder:7b',
      mode: 'standard',
      briefQuality: { score: 0.94, passed: true, errorCount: 0, warningCount: 1 },
      driftSummary: { score: 0.98, passed: true, errorCount: 0, warningCount: 0 },
      phaseTimings: { planning: 18_000, implementing: 52_000, validating: 12_000 },
    }),
  }));

function publishFreshDiscovery(): void {
  const request = detectionStore.beginRefresh({
    contexts: {
      readiness: 'visual-readiness',
      modelsDev: 'visual-models-dev',
      cliModels: 'visual-cli-models',
    },
  });
  const result: DetectionServiceResult = {
    providers: [],
    cliTools: [cliDetectionFor('ready', 'claude-code'), cliDetectionFor('ready', 'codex')],
    catalog: {},
    cliModels: [],
    generation: 1,
  };
  detectionStore.publish({ result, request });
}

export const createSetupFixture: FixtureFactory = () => ({
  setup: (context) => {
    setupVisualFixture(context);
    publishFreshDiscovery();
    routerStore.init({ screen: 'setup', onComplete: 'home' });
  },
  teardown: teardownVisualFixture,
});

export const screenFixtureRegistry: FixtureRegistry = new Map([
  [scenarioId('home-empty'), createHomeFixture],
  [scenarioId('summary-success'), createSummaryFixture],
  [scenarioId('setup-initial'), createSetupFixture],
]);
