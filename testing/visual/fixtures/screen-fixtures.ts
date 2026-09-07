import { mkdirSync, rmSync } from 'node:fs';
import { modelCacheStore } from '../../../src/stores/discovery/model-cache/state.js';
import type { RouteData } from '../../../src/stores/navigation/router.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { configStore } from '../../../src/stores/project/config.js';
import { detectionStore } from '../../../src/stores/project/detection.js';
import { skillsStore } from '../../../src/stores/project/skills.js';
import { composerDraftStore } from '../../../src/stores/ui/composer-draft.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import { resetWorkflow } from '../../../src/stores/workflow/actions/reset.js';
import type { CliToolDetection } from '../../../src/core/discovery/detection.js';
import type { ClaudeCodeModelOption } from '../../../src/core/providers/claude-code-options.js';
import type { ScopedCliCatalogAttempt } from '../../../src/engine/detection/cli-catalog-outcomes.js';
import type { ModelsDevRefreshOutcome } from '../../../src/engine/detection/models-dev-lane.js';
import type { Config } from '../../../src/core/schemas/config.js';
import type { ModelsDevCatalog } from '../../../src/core/schemas/models-dev.js';
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

/**
 * The context keys every visual fixture publishes discovery under. A lane
 * publication is dropped when its key does not match the request's.
 */
const VISUAL_DETECTION_CONTEXTS = {
  readiness: 'visual-readiness',
  modelsDev: 'visual-models-dev',
  cliModels: 'visual-cli-models',
} as const;

/** Frames are byte-compared, so every lane is stamped with a fixed instant. */
export const VISUAL_PUBLISHED_AT = 1_786_000_000_000;

/**
 * The one entry Claude Code's per-account `~/.claude.json` option cache really
 * holds; pinned so a capture is the same on a developer's machine and on CI.
 */
export const CLAUDE_CODE_OPTION_CACHE: readonly ClaudeCodeModelOption[] = [
  { id: 'claude-fable-5-1[1m]', displayName: 'Fable' },
];

const VISUAL_FIXTURE_WORK_DIR = `.test-artifacts/ui-fixture-worker-${process.pid}`;
export const VISUAL_FIXTURE_PROJECT_DIR = `${VISUAL_FIXTURE_WORK_DIR}/ui-fixture-project`;

type VisualConfigOverrides = Parameters<typeof makeConfig>[0];

type VisualModelsDevArm = 'not-run' | 'pending' | 'failed' | { readonly catalog: ModelsDevCatalog };

const BASE_PLANNER = {
  kind: 'cli',
  tool: 'claude-code',
  model: 'claude-sonnet-4',
} as const;

const BASE_IMPLEMENTER = {
  kind: 'api',
  provider: 'ollama',
  model: 'qwen2.5-coder:7b',
  apiBase: 'http://127.0.0.1:11434/v1',
  contextLength: 32_768,
  temperature: 0.2,
} as const;

const BASE_WORKFLOW = {
  mode: 'standard',
  persistTranscript: false,
  maxRetries: 2,
} as const;

/**
 * A seat override replaces the whole seat — `planner`, `implementer` and
 * `reviewer` overrides must be complete. `workflow` is merged, so a scenario can
 * change the mode without losing the pinned transcript and retry settings.
 */
export function visualConfig(overrides?: VisualConfigOverrides): Config {
  return makeConfig({
    planner: BASE_PLANNER,
    implementer: BASE_IMPLEMENTER,
    ...overrides,
    workflow: { ...BASE_WORKFLOW, ...overrides?.workflow },
  });
}

export function resetVisualFixtureStores(): void {
  resetAllStores();
  resetWorkflow();
}

export function setupVisualFixture(context: FixtureContext): void {
  removeFixtureProject();
  mkdirSync(VISUAL_FIXTURE_PROJECT_DIR, { recursive: true });
  resetVisualFixtureStores();
  modelCacheStore.__testSetClaudeCodeModelOptions(CLAUDE_CODE_OPTION_CACHE);
  seedVisualConfig();
  terminalSizeStore.__testReset({
    cols: context.viewport.cols,
    rows: context.viewport.rows,
    isSmall: context.viewport.cols < 120,
  });
}

export function seedVisualConfig(overrides?: VisualConfigOverrides): void {
  const config = visualConfig(overrides);
  configStore.__testReset({
    config,
    diskConfig: config,
    projectDir: VISUAL_FIXTURE_PROJECT_DIR,
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

interface HomeFixtureOptions {
  readonly config?: VisualConfigOverrides;
  readonly cold?: boolean;
}

const HOME_FIXTURE_SKILLS = new Set(['brief-discipline', 'repo-conventions']);

export function createHomeFixture(options: HomeFixtureOptions = {}): FixtureLifecycle {
  return {
    setup: (context) => {
      setupVisualFixture(context);
      if (options.config !== undefined) seedVisualConfig(options.config);
      skillsStore.setSelected(HOME_FIXTURE_SKILLS);
      if (options.cold !== true) publishFreshDiscovery();
      routerStore.init({ screen: 'home' });
    },
    teardown: teardownVisualFixture,
  };
}

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
  publishVisualDiscovery({
    cliTools: [cliDetectionFor('ready', 'claude-code'), cliDetectionFor('ready', 'codex')],
    modelsDev: { catalog: {} },
  });
}

/**
 * The one discovery publisher every visual fixture uses. Tools already detected
 * survive unless the caller restates them, so a scenario names only the tool it
 * is about. A `pending` models.dev lane is left unsettled on purpose — that is
 * the fetching notice the cold picker frame shows.
 */
export function publishVisualDiscovery(input: {
  readonly cliTools: readonly CliToolDetection[];
  readonly cliModels?: readonly ScopedCliCatalogAttempt[];
  readonly modelsDev?: VisualModelsDevArm;
}): void {
  const detection = detectionStore.get();
  const seeded = new Set(input.cliTools.map((tool) => tool.tool));
  const readiness = {
    providers: [...detection.providers],
    cliTools: [...detection.cliTools.filter((tool) => !seeded.has(tool.tool)), ...input.cliTools],
  };
  const request = detectionStore.beginRefresh({ contexts: VISUAL_DETECTION_CONTEXTS });
  detectionStore.publishLane({
    request,
    lane: {
      lane: 'readiness',
      outcome: {
        kind: 'fresh',
        origin: 'request',
        snapshot: laneSnapshot({
          source: 'readiness',
          contextKey: VISUAL_DETECTION_CONTEXTS.readiness,
          requestId: request.id,
          value: readiness,
        }),
      },
    },
  });
  detectionStore.publishLane({
    request,
    lane: {
      lane: 'cliModels',
      outcome: {
        kind: 'fresh',
        origin: 'request',
        snapshot: laneSnapshot({
          source: 'cli-models',
          contextKey: VISUAL_DETECTION_CONTEXTS.cliModels,
          requestId: request.id,
          value: input.cliModels ?? [],
        }),
      },
    },
  });
  const modelsDev = input.modelsDev ?? 'not-run';
  if (modelsDev === 'pending') return;
  detectionStore.publishLane({
    request,
    lane: { lane: 'modelsDev', outcome: modelsDevOutcome(modelsDev, request.id) },
  });
}

function laneSnapshot<Source extends string, Value extends object>(options: {
  readonly source: Source;
  readonly contextKey: string;
  readonly requestId: number;
  readonly value: Value;
}) {
  const { source, contextKey, requestId, value } = options;
  return {
    source,
    contextKey,
    generation: 1,
    requestId,
    fetchedAt: VISUAL_PUBLISHED_AT,
    validatedAt: VISUAL_PUBLISHED_AT,
    stale: false,
    value,
  } as const;
}

function modelsDevOutcome(
  arm: Exclude<VisualModelsDevArm, 'pending'>,
  requestId: number,
): ModelsDevRefreshOutcome {
  if (arm === 'not-run') {
    return {
      kind: 'not-run',
      source: 'models-dev',
      contextKey: VISUAL_DETECTION_CONTEXTS.modelsDev,
      reason: 'uninitialized',
    };
  }
  if (arm === 'failed') {
    return {
      kind: 'failed',
      source: 'models-dev',
      contextKey: VISUAL_DETECTION_CONTEXTS.modelsDev,
      generation: 1,
      requestId,
      checkedAt: VISUAL_PUBLISHED_AT,
      failure: { kind: 'request-failed', message: 'models.dev is unreachable' },
    };
  }
  return {
    kind: 'fresh',
    origin: 'request',
    snapshot: laneSnapshot({
      source: 'models-dev',
      contextKey: VISUAL_DETECTION_CONTEXTS.modelsDev,
      requestId,
      value: arm.catalog,
    }),
  };
}

export const createSetupFixture: FixtureFactory = () => ({
  setup: (context) => {
    setupVisualFixture(context);
    publishFreshDiscovery();
    routerStore.init({ screen: 'setup', onComplete: 'home' });
  },
  teardown: teardownVisualFixture,
});

function createCommandArgumentFixture(): FixtureLifecycle {
  const workflow = createWorkflowBaseFixture();
  return {
    setup: async (context) => {
      await workflow.setup(context);
      composerDraftStore.request('/copy ');
    },
    teardown: workflow.teardown,
  };
}

const HOME_REVIEWER_API_SEAT = {
  kind: 'api',
  provider: 'custom-endpoint',
  model: 'o3',
  apiBase: 'https://api.example.test/v1',
} as const;

export const screenFixtureRegistry: FixtureRegistry = new Map([
  [scenarioId('home-empty'), () => createHomeFixture()],
  [
    scenarioId('home-reviewer'),
    () =>
      createHomeFixture({
        config: { reviewer: { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' } },
      }),
  ],
  [
    scenarioId('home-floor-collapsed'),
    () => createHomeFixture({ config: { reviewer: HOME_REVIEWER_API_SEAT } }),
  ],
  [scenarioId('home-cold'), () => createHomeFixture({ cold: true })],
  [scenarioId('workflow-command-argument'), createCommandArgumentFixture],
  [scenarioId('setup-initial'), createSetupFixture],
]);
