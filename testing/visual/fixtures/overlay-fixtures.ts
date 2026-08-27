import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OverlayType } from '../../../src/core/navigation/types.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import type {
  CliProviderAuth,
  CliProviderAuthUnreadableReason,
} from '../../../src/core/discovery/detection.js';
import { ModelsDevCatalogSchema } from '../../../src/core/schemas/models-dev.js';
import type { ScopedCliCatalogAttempt } from '../../../src/engine/detection/cli-catalog-outcomes.js';
import { overlayStore } from '../../../src/stores/ui/overlay.js';
import { editorStore } from '../../../src/stores/ui/editor.js';
import { pickerViewStore } from '../../../src/stores/ui/picker-view.js';
import { detectionStore } from '../../../src/stores/project/detection.js';
import { sessionsStore } from '../../../src/stores/project/sessions.js';
import { skillsStore } from '../../../src/stores/project/skills.js';
import { modelCacheStore } from '../../../src/stores/discovery/model-cache.js';
import { reviewStore } from '../../../src/stores/workflow/review.js';
import { tokensStore } from '../../../src/stores/workflow/tokens.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { scenarioId } from '../contracts/identifiers.js';
import { cliDetectionFor } from '../../helpers/factories/detection.js';
import { makeSession } from '../../helpers/factories/session.js';
import { makeSummary, makeUsage } from '../../helpers/factories/summary.js';
import type { FixtureFactory, FixtureLifecycle, FixtureRegistry } from './common.js';
import {
  publishVisualDiscovery,
  seedVisualConfig,
  setupVisualFixture,
  teardownVisualFixture,
  type visualConfig,
  VISUAL_FIXTURE_PROJECT_DIR,
  VISUAL_PUBLISHED_AT,
} from './screen-fixtures.js';

type OverlaySeed = () => void;
type OverlayUnderlyingScreen = 'home' | 'workflow';
type VisualConfigOverrides = Parameters<typeof visualConfig>[0];

const EMPTY_SEED: OverlaySeed = () => {};

/** The merged two-route row the provider-expansion frames open on. */
const OPENCODE_ROUTED_MODEL = 'openai/gpt-5.6-luna';
const AIDER_ROUTED_MODEL = 'anthropic/claude-sonnet-4';

/** Opens the picker on OpenCode with the model column live, as the frames show. */
const OPENCODE_FOCUS = 'tool:opencode';

function fixtureIds(name: string): string[] {
  return readFileSync(join(import.meta.dirname, '../../fixtures/', name), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
}

function modelsDevSlice(): ReturnType<typeof ModelsDevCatalogSchema.parse> {
  const raw = readFileSync(
    join(import.meta.dirname, '../../fixtures/models-dev-slice.json'),
    'utf8',
  );
  return ModelsDevCatalogSchema.parse(JSON.parse(raw));
}

function hydrateSlice(): void {
  modelCacheStore.hydrateModelsDevCatalog({
    catalog: modelsDevSlice(),
    fetchedAt: VISUAL_PUBLISHED_AT,
    validatedAt: VISUAL_PUBLISHED_AT,
  });
}

function catalogAttempt(input: {
  tool: ScopedCliCatalogAttempt['connection']['tool'];
  outcome: ScopedCliCatalogAttempt['outcome'];
}): ScopedCliCatalogAttempt {
  return {
    connection: { role: 'planner', tool: input.tool, contextKey: `planner-${input.tool}-visual` },
    outcome: input.outcome,
  };
}

function seedRunnerCatalog(): void {
  detectionStore.setDetection({
    cliTools: [
      {
        tool: 'claude-code',
        executable: null,
        trust: 'trusted',
        installedVersion: '2.4.0',
        testedVersion: '2.4.0',
        compatibility: 'compatible',
        auth: 'authenticated',
        diagnostic: { state: 'ready', remediation: null },
        probedAt: 1_786_000_000_000,
      },
      {
        tool: 'codex',
        executable: null,
        trust: 'trusted',
        installedVersion: '1.2.0',
        testedVersion: '1.2.0',
        compatibility: 'compatible',
        auth: 'authenticated',
        diagnostic: { state: 'ready', remediation: null },
        probedAt: 1_786_000_000_000,
      },
    ],
    providers: [
      {
        provider: 'ollama',
        available: true,
        isLocal: true,
        hasKey: false,
        models: [
          { id: 'qwen2.5-coder:7b', contextLength: 32_768 },
          { id: 'deepseek-coder-v2:16b', contextLength: 65_536 },
        ],
      },
    ],
  });
  modelCacheStore.setProviderModels('ollama', [
    { id: 'qwen2.5-coder:7b', contextLength: 32_768 },
    { id: 'deepseek-coder-v2:16b', contextLength: 65_536 },
  ]);
}

function seedSkills(): void {
  skillsStore.setAvailable([
    {
      id: 'terminal-layout',
      name: 'Terminal layout',
      description: 'Check spacing and terminal-width behavior',
      path: 'fixtures/skills/terminal-layout/SKILL.md',
      scope: 'project',
      projectDir: VISUAL_FIXTURE_PROJECT_DIR,
    },
    {
      id: 'release-checks',
      name: 'Release checks',
      description: 'Run deterministic quality gates',
      path: 'fixtures/skills/release-checks/SKILL.md',
      scope: 'global',
    },
  ]);
  skillsStore.setSelected(new Set(['terminal-layout']));
}

function seedSessions(): void {
  const session = makeSession({
    id: 'visual-session',
    feature: 'Refine terminal navigation',
    startedAt: 1_735_732_800_000,
    completedAt: 1_735_732_882_000,
    status: 'complete',
    summary: makeSummary({
      feature: 'Refine terminal navigation',
      totalTasks: 4,
      completedByLocal: 4,
      totalTime: 82_000,
      estimatedCostSavings: '$4.80',
    }),
  });
  // The sessions overlay re-reads the project directory on mount, so the
  // session has to exist on disk to survive to the capture.
  const dir = join(sessionsRoot(VISUAL_FIXTURE_PROJECT_DIR), session.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(session));
  sessionsStore.__testReset({ sessions: [session], allSessions: [session], totalCount: 1 });
}

function seedEditor(): void {
  const filePath = 'fixtures/visual-session/plan.md';
  const ownerToken = reviewStore.setReviewFile(filePath, 8);
  editorStore.openRaw({
    filePath,
    ownerToken,
    value: [
      '# Visual fixture plan',
      '',
      '1. Capture the production app.',
      '2. Verify terminal cell geometry.',
      '3. Export safe diagnostic artifacts.',
    ].join('\n'),
    layout: { columns: 72, rows: 19 },
  });
}

function seedCostBreakdown(): void {
  tokensStore.__testReset({
    localCount: 3,
    escalatedCount: 1,
    completedTaskCount: 4,
    tokenUsage: makeUsage({
      plannerInput: 4_200,
      plannerOutput: 1_100,
      implementerInput: 12_400,
      implementerOutput: 3_800,
      escalationInput: 1_200,
      escalationOutput: 440,
      reviewerInput: 1_800,
      reviewerOutput: 600,
    }),
    pricingContext: {
      plannerTool: 'claude-code',
      plannerModel: 'claude-sonnet-4',
      implementerTool: 'ollama',
      implementerModel: 'qwen2.5-coder:7b',
      reviewerTool: 'codex',
      reviewerModel: 'gpt-5-codex',
    },
    perPhase: {
      planning: {
        inputTokens: 4_200,
        outputTokens: 1_100,
        cacheReadTokens: 800,
        cacheCreateTokens: 0,
      },
      implementing: {
        inputTokens: 13_600,
        outputTokens: 4_240,
        cacheReadTokens: 2_100,
        cacheCreateTokens: 320,
      },
    },
    perTask: {
      T001: {
        title: 'Build terminal fixture',
        totalTokens: 8_400,
        attempts: [
          {
            method: 'local',
            implementerTokens: 8_400,
            escalationTokens: 0,
            retryCount: 0,
            tool: 'ollama',
            model: 'qwen2.5-coder:7b',
            implementerProfile: 'local-fast',
            contextFit: 'fits',
            estimatedTokens: 7_900,
            contextLength: 32_768,
            costPosture: 'local',
          },
        ],
      },
      T002: {
        title: 'Verify artifact geometry',
        totalTokens: 5_440,
        attempts: [
          {
            method: 'escalated-full',
            implementerTokens: 3_800,
            escalationTokens: 1_640,
            retryCount: 1,
            tool: 'ollama',
            model: 'qwen2.5-coder:7b',
            implementerProfile: 'local-fast',
            contextFit: 'tight',
            estimatedTokens: 29_100,
            contextLength: 32_768,
            routingReason: 'Complex terminal geometry verification',
          },
        ],
      },
    },
  });
}

const AIDER_CATALOG_IDS = [
  AIDER_ROUTED_MODEL,
  'openrouter/claude-sonnet-4',
  'anthropic/claude-opus-4',
  'openrouter/claude-opus-4',
  'anthropic/claude-haiku-3-5',
  'openrouter/claude-haiku-3-5',
  'openai/gpt-5.1',
  'openrouter/gpt-5.1',
  'openai/o4-mini',
  'openrouter/o4-mini',
];

function seedConfig(overrides?: VisualConfigOverrides): OverlaySeed {
  return () => seedVisualConfig(overrides);
}

function seedOpencodeCatalog(): void {
  // OpenCode's routes are one fact: the `opencode` provider block of the
  // models.dev slice. A second hand-written list drifts from it silently, since
  // an unmatched id just renders without metadata.
  const routes = modelsDevSlice().opencode?.models;
  if (routes === undefined) throw new Error('models-dev-slice.json has no opencode provider');
  seedConfig({ planner: { kind: 'cli', tool: 'opencode', model: OPENCODE_ROUTED_MODEL } })();
  publishVisualDiscovery({
    cliTools: [cliDetectionFor('ready', 'opencode')],
    cliModels: [
      catalogAttempt({
        tool: 'opencode',
        outcome: { kind: 'success', value: Object.keys(routes).map((id) => ({ id })) },
      }),
    ],
  });
  hydrateSlice();
}

function seedProviderAuth(
  arm: 'read' | 'empty' | 'unreadable',
  reason: CliProviderAuthUnreadableReason = 'parse-failure',
): void {
  seedOpencodeCatalog();
  const providerAuth: CliProviderAuth =
    arm === 'read'
      ? { kind: 'read', facts: [{ provider: 'OpenAI', source: 'api' }] }
      : arm === 'empty'
        ? { kind: 'empty' }
        : { kind: 'unreadable', reason };
  const detection = detectionStore.get();
  detectionStore.setDetection({
    providers: [...detection.providers],
    cliTools: [
      ...detection.cliTools.filter((tool) => tool.tool !== 'opencode'),
      cliDetectionFor('ready', 'opencode', { providerAuth }),
    ],
  });
}

function seedAiderMultiRoute(): void {
  seedConfig({ planner: { kind: 'cli', tool: 'aider', model: AIDER_ROUTED_MODEL } })();
  publishVisualDiscovery({
    cliTools: [cliDetectionFor('ready', 'aider')],
    cliModels: [
      catalogAttempt({
        tool: 'aider',
        outcome: { kind: 'success', value: AIDER_CATALOG_IDS.map((id) => ({ id })) },
      }),
    ],
  });
  hydrateSlice();
}

function seedModelsDevLane(outcome: 'uninitialized' | 'failed'): OverlaySeed {
  return () => {
    publishVisualDiscovery({
      cliTools: [cliDetectionFor('ready', 'claude-code')],
      modelsDev: outcome === 'failed' ? 'failed' : 'pending',
    });
  };
}

function seedClaudeCodeUnsupported(): void {
  publishVisualDiscovery({
    cliTools: [cliDetectionFor('ready', 'claude-code')],
    cliModels: [catalogAttempt({ tool: 'claude-code', outcome: { kind: 'unsupported' } })],
    modelsDev: { catalog: modelsDevSlice() },
  });
}

function seedKiloConfirmed(): void {
  const ids = fixtureIds('kilo-models-7.0.49.txt');
  const persisted = ids[4] ?? ids[0] ?? 'kilo/kilo-auto/free';
  seedConfig({ planner: { kind: 'cli', tool: 'kilo-code', model: persisted } })();
  publishVisualDiscovery({
    cliTools: [cliDetectionFor('ready', 'kilo-code')],
    cliModels: [
      catalogAttempt({
        tool: 'kilo-code',
        outcome: { kind: 'success', value: ids.map((id) => ({ id })) },
      }),
    ],
  });
}

function seedKiloMalformed(): void {
  seedConfig({ planner: { kind: 'cli', tool: 'kilo-code', model: 'kilo/kilo-auto/free' } })();
  publishVisualDiscovery({
    cliTools: [cliDetectionFor('ready', 'kilo-code')],
    cliModels: [catalogAttempt({ tool: 'kilo-code', outcome: { kind: 'malformed' } })],
  });
}

function createOverlayFixture(options: {
  readonly overlay: OverlayType;
  readonly seed?: OverlaySeed;
  readonly underlyingScreen?: OverlayUnderlyingScreen;
  readonly focus?: string;
}): FixtureLifecycle {
  const { overlay, seed = EMPTY_SEED, underlyingScreen = 'home', focus } = options;
  let stopReseed: (() => void) | undefined;
  return {
    setup: (context) => {
      setupVisualFixture(context);
      routerStore.init(
        underlyingScreen === 'workflow'
          ? {
              screen: 'workflow',
              execution: {
                kind: 'attached',
                feature: 'Inspect visual fixture',
                sessionId: 'visual-overlay-session',
                attach: { sockPath: '/tmp/visual-overlay.sock', authToken: 'visual-token' },
              },
            }
          : { screen: underlyingScreen },
      );
      seedRunnerCatalog();
      seed();
      if (underlyingScreen === 'workflow') stopReseed = reseedAfterWorkflowReset(seed);
      overlayStore.open(overlay, focus);
    },
    teardown: () => {
      stopReseed?.();
      stopReseed = undefined;
      teardownVisualFixture();
    },
  };
}

// The attached workflow screen resets the session-scoped stores in a mount
// effect (`use-attachment.ts:54`), which runs after this fixture has seeded
// them — `resetWorkflow` clears the token totals a workflow overlay reads. The
// first token reset after setup is that wipe, so re-apply the seed there.
function reseedAfterWorkflowReset(seed: OverlaySeed): () => void {
  const stop = tokensStore.subscribe(() => {
    stop();
    seed();
  });
  return stop;
}

const REVIEWER_SEAT = { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' } as const;
const REVIEWER_API_SEAT = {
  kind: 'api',
  provider: 'openai',
  model: 'o3',
  apiBase: 'https://api.openai.com/v1',
  effort: 'high',
} as const;
const ESCALATION_SEAT = {
  intermediateProvider: 'deepseek',
  intermediateModel: 'deepseek-chat',
} as const;
/** The verdict line only exists when both BUILD and REVIEW resolve to a lab, so BUILD names one. */
const BUILD_ANTHROPIC_SEAT = {
  kind: 'cli',
  tool: 'claude-code',
  model: 'claude-sonnet-4',
} as const;
const PLANNER_HIGH_EFFORT = {
  kind: 'cli',
  tool: 'claude-code',
  model: 'claude-sonnet-4',
  effort: 'high',
} as const;

const createHelpFixture: FixtureFactory = () =>
  createOverlayFixture({ overlay: 'help', underlyingScreen: 'workflow' });
const createPaletteFixture: FixtureFactory = () =>
  createOverlayFixture({ overlay: 'command-palette', underlyingScreen: 'workflow' });
const createSkillsFixture: FixtureFactory = () =>
  createOverlayFixture({ overlay: 'skills', seed: seedSkills });
const createSettingsFixture: FixtureFactory = () => createOverlayFixture({ overlay: 'settings' });
const createSettingsCrewFullFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'settings',
    seed: seedConfig({
      planner: PLANNER_HIGH_EFFORT,
      implementer: BUILD_ANTHROPIC_SEAT,
      reviewer: REVIEWER_SEAT,
      escalation: ESCALATION_SEAT,
    }),
    focus: 'seat:build',
  });
const createSettingsInheritedEffortFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'settings',
    seed: seedConfig({ planner: PLANNER_HIGH_EFFORT }),
    focus: 'effort:review',
  });
const createSettingsFloorFullFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'settings',
    seed: seedConfig({
      planner: PLANNER_HIGH_EFFORT,
      reviewer: REVIEWER_API_SEAT,
      escalation: ESCALATION_SEAT,
    }),
    focus: 'seat:build',
  });
const createSettingsFilteredFixture: FixtureFactory = () =>
  createOverlayFixture({ overlay: 'settings', focus: 'filter:temp' });
const createSettingsFilterPlanFixture: FixtureFactory = () =>
  createOverlayFixture({ overlay: 'settings', focus: 'filter:plan' });
const createModeSelectorFixture: FixtureFactory = () =>
  createOverlayFixture({ overlay: 'mode-selector' });
const createPlannerPickerFixture: FixtureFactory = () =>
  createOverlayFixture({ overlay: 'planner-picker' });
const createPlannerPickerCatalogFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: seedOpencodeCatalog,
    focus: OPENCODE_FOCUS,
  });
const createProviderExpandedReadFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: () => {
      seedProviderAuth('read');
      pickerViewStore.expand(OPENCODE_ROUTED_MODEL);
    },
    focus: OPENCODE_FOCUS,
  });
const createProviderExpandedEmptyFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: () => {
      seedProviderAuth('empty');
      pickerViewStore.expand(OPENCODE_ROUTED_MODEL);
    },
    focus: OPENCODE_FOCUS,
  });
const createProviderExpandedUnreadableFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: () => {
      seedProviderAuth('unreadable', 'parse-failure');
      pickerViewStore.expand(OPENCODE_ROUTED_MODEL);
    },
    focus: OPENCODE_FOCUS,
  });
const createRoutesUncheckedFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: () => {
      seedAiderMultiRoute();
      pickerViewStore.expand(AIDER_ROUTED_MODEL);
    },
    focus: 'tool:aider',
  });
const createPlannerPickerColdFixture: FixtureFactory = () =>
  createOverlayFixture({ overlay: 'planner-picker', seed: seedModelsDevLane('uninitialized') });
const createPlannerPickerNoListingFixture: FixtureFactory = () =>
  createOverlayFixture({ overlay: 'planner-picker', seed: seedClaudeCodeUnsupported });
const createPlannerPickerKiloFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: seedKiloConfirmed,
    focus: 'tool:kilo-code',
  });
const createPlannerPickerMalformedFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: seedKiloMalformed,
    focus: 'tool:kilo-code',
  });
const createContractChoiceFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: () => {
      seedConfig({ planner: { kind: 'shell', command: 'my-planner --json' } })();
      pickerViewStore.open({ kind: 'custom-command-contract' });
    },
  });
const createCustomCommandFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: () => pickerViewStore.open({ kind: 'custom-command', intendedKind: 'shell' }),
  });
const createCustomModelFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: () => pickerViewStore.open({ kind: 'custom-model' }),
    focus: 'tool:ollama',
  });
const createApiKeyFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: () => pickerViewStore.open({ kind: 'provider-auth' }),
    focus: 'tool:deepseek',
  });
const createImplementerPickerFixture: FixtureFactory = () =>
  createOverlayFixture({ overlay: 'implementer-picker' });
const createReviewerPickerFixture: FixtureFactory = () =>
  createOverlayFixture({ overlay: 'reviewer-picker' });
const createReviewerPickerToolFixture: FixtureFactory = () =>
  createOverlayFixture({ overlay: 'reviewer-picker', focus: 'tool:codex' });
const createSessionsFixture: FixtureFactory = () =>
  createOverlayFixture({ overlay: 'sessions', seed: seedSessions });
const createEditorFixture: FixtureFactory = () =>
  createOverlayFixture({ overlay: 'editor', seed: seedEditor, underlyingScreen: 'workflow' });
const createCostDrilldownFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'cost-drilldown',
    seed: seedCostBreakdown,
    underlyingScreen: 'workflow',
  });

export const overlayFixtureRegistry: FixtureRegistry = new Map([
  [scenarioId('overlay-help'), createHelpFixture],
  [scenarioId('overlay-command-palette'), createPaletteFixture],
  [scenarioId('overlay-skills'), createSkillsFixture],
  [scenarioId('overlay-settings'), createSettingsFixture],
  [scenarioId('overlay-settings-crew-full'), createSettingsCrewFullFixture],
  [scenarioId('overlay-settings-inherited-effort'), createSettingsInheritedEffortFixture],
  [scenarioId('overlay-settings-floor-full'), createSettingsFloorFullFixture],
  [scenarioId('overlay-settings-filtered'), createSettingsFilteredFixture],
  [scenarioId('overlay-settings-filter-plan'), createSettingsFilterPlanFixture],
  [scenarioId('overlay-mode-selector'), createModeSelectorFixture],
  [scenarioId('overlay-planner-picker'), createPlannerPickerFixture],
  [scenarioId('overlay-planner-picker-catalog'), createPlannerPickerCatalogFixture],
  [scenarioId('overlay-picker-provider-expanded-read'), createProviderExpandedReadFixture],
  [scenarioId('overlay-picker-provider-expanded-empty'), createProviderExpandedEmptyFixture],
  [
    scenarioId('overlay-picker-provider-expanded-unreadable'),
    createProviderExpandedUnreadableFixture,
  ],
  [scenarioId('overlay-picker-routes-unchecked'), createRoutesUncheckedFixture],
  [scenarioId('overlay-planner-picker-cold'), createPlannerPickerColdFixture],
  [scenarioId('overlay-planner-picker-no-listing'), createPlannerPickerNoListingFixture],
  [scenarioId('overlay-planner-picker-kilo'), createPlannerPickerKiloFixture],
  [scenarioId('overlay-planner-picker-malformed'), createPlannerPickerMalformedFixture],
  [scenarioId('overlay-picker-contract-choice'), createContractChoiceFixture],
  [scenarioId('overlay-picker-custom-command'), createCustomCommandFixture],
  [scenarioId('overlay-picker-custom-model'), createCustomModelFixture],
  [scenarioId('overlay-picker-api-key'), createApiKeyFixture],
  [scenarioId('overlay-implementer-picker'), createImplementerPickerFixture],
  [scenarioId('overlay-reviewer-picker-inherited'), createReviewerPickerFixture],
  [scenarioId('overlay-reviewer-picker-tool'), createReviewerPickerToolFixture],
  [scenarioId('overlay-sessions'), createSessionsFixture],
  [scenarioId('overlay-editor'), createEditorFixture],
  [scenarioId('overlay-cost-drilldown'), createCostDrilldownFixture],
]);
