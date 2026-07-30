import { rmSync } from 'node:fs';
import type { RouteData } from '../../../src/stores/navigation/router.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { configStore } from '../../../src/stores/project/config.js';
import { questionPromptStore } from '../../../src/stores/question-prompt/prompt.js';
import { completionStore } from '../../../src/stores/ui/completion.js';
import { editorStore } from '../../../src/stores/ui/editor.js';
import { externalEditRequestStore } from '../../../src/stores/ui/external-edit-request.js';
import { projectFilesStore } from '../../../src/stores/ui/project-files.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import { resetWorkflow } from '../../../src/stores/workflow/actions/reset.js';
import { operationsStore } from '../../../src/stores/workflow/operations/state.js';
import type { ReadinessReport } from '../../../src/core/readiness/types.js';
import { scenarioId } from '../contracts/identifiers.js';
import { makeConfig } from '../../helpers/factories/config.js';
import { makeSummary } from '../../helpers/factories/summary.js';
import { resetAllStores } from '../../helpers/stores.js';
import type {
  FixtureContext,
  FixtureFactory,
  FixtureLifecycle,
  FixtureRegistry,
} from './common.js';

export const VISUAL_FIXTURE_PROJECT_DIR = '.test-artifacts/projects/splitbrief';

const FIXED_GENERATED_AT = '2025-01-01T12:00:00.000Z';

function visualConfig() {
  return makeConfig({
    planner: {
      kind: 'cli',
      tool: 'claude-code',
      model: 'claude-sonnet-4-6',
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
  rmSync(VISUAL_FIXTURE_PROJECT_DIR, { recursive: true, force: true });
}

function readyReadiness(): ReadinessReport {
  return {
    generatedAt: FIXED_GENERATED_AT,
    projectDir: VISUAL_FIXTURE_PROJECT_DIR,
    status: 'ready',
    counts: { ok: 1, info: 0, warning: 0, blocker: 0 },
    nextAction: {
      kind: 'continue',
      label: 'Continue',
      reason: 'Planner and implementer are ready',
    },
    sections: [],
    metadata: { mode: 'standard', configExists: true },
  };
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

export const createWorkflowBaseFixture: FixtureFactory = () =>
  createRouteFixture(() => ({
    screen: 'workflow',
    feature: 'Add Ollama model discovery',
    sessionId: 'visual-workflow',
    readiness: readyReadiness(),
  }));

export const createSummaryFixture: FixtureFactory = () =>
  createRouteFixture(() => ({
    screen: 'summary',
    sessionId: 'visual-summary',
    status: 'complete',
    summary: makeSummary({
      feature: 'Ollama model discovery complete',
      totalTasks: 4,
      completedByLocal: 3,
      escalatedToPlanner: 1,
      totalTime: 82_000,
      estimatedCostSavings: '$4.80',
      escalationRate: 0.25,
      plannerTool: 'claude-code',
      plannerModel: 'claude-sonnet-4-6',
      implementerTool: 'ollama',
      implementerModel: 'qwen2.5-coder:7b',
      mode: 'standard',
      briefQuality: { score: 0.94, passed: true, errorCount: 0, warningCount: 1 },
      driftSummary: { score: 0.98, passed: true, errorCount: 0, warningCount: 0 },
      phaseTimings: { planning: 18_000, implementing: 52_000, validating: 12_000 },
    }),
  }));

export const createSetupFixture: FixtureFactory = () =>
  createRouteFixture(() => ({ screen: 'setup', onComplete: 'home' }));

export const screenFixtureRegistry: FixtureRegistry = new Map([
  [scenarioId('home-empty'), createHomeFixture],
  [scenarioId('summary-success'), createSummaryFixture],
  [scenarioId('setup-initial'), createSetupFixture],
]);
