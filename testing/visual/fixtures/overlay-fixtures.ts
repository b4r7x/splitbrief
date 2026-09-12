import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OverlayType } from '../../../src/core/navigation/types.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import type {
  CliProviderAuth,
  CliProviderAuthUnreadableReason,
  DetectedModel,
} from '../../../src/core/discovery/detection.js';
import {
  nativeCliCatalogToDetectedModels,
  parseCopilotHelpConfigCatalog,
  parseKiloNativeModelCatalog,
  parseOpenCodeNativeModelCatalog,
} from '../../../src/engine/providers/cli-model-catalog.js';
import { ModelsDevCatalogSchema } from '../../../src/core/schemas/models-dev.js';
import { seatAxisFocus } from '../../../src/core/navigation/types.js';
import type { ScopedCliCatalogAttempt } from '../../../src/engine/detection/cli-catalog-outcomes.js';
import type { PreparedExecution } from '../../../src/engine/runners/prepared-execution.js';
import { configStore } from '../../../src/stores/project/config.js';
import { overlayStore } from '../../../src/stores/ui/overlay.js';
import { editorStore } from '../../../src/stores/ui/editor.js';
import { pickerViewStore } from '../../../src/stores/ui/picker-view.js';
import { detectionStore } from '../../../src/stores/project/detection.js';
import { sessionsStore } from '../../../src/stores/project/sessions.js';
import { skillsStore } from '../../../src/stores/project/skills.js';
import { modelCacheStore } from '../../../src/stores/discovery/model-cache/state.js';
import { reviewStore } from '../../../src/stores/workflow/review.js';
import { tokensStore } from '../../../src/stores/workflow/tokens.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { prepareWorkflowExecution } from '../../helpers/workflow-screen.js';
import { scenarioId } from '../contracts/identifiers.js';
import { cursorDetectedModels } from '../../helpers/factories/cursor-models.js';
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

function overlayPrepared(): PreparedExecution {
  const config = configStore.get().config;
  if (config === null) throw new Error('Visual overlay fixture requires project config');
  return prepareWorkflowExecution({
    projectDir: VISUAL_FIXTURE_PROJECT_DIR,
    feature: 'Inspect visual fixture',
    config,
    sessionId: 'visual-overlay-session',
  });
}

/** The merged two-route row the provider-expansion frames open on. */
const OPENCODE_ROUTED_MODEL = 'openai/gpt-5.6-luna';

/** Opens the picker on OpenCode with the model column live, as the frames show. */
const OPENCODE_FOCUS = 'tool:opencode';

function fixtureIds(name: string): string[] {
  return readFileSync(join(import.meta.dirname, '../../fixtures/', name), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
}

function opencodeVerboseModels(): readonly DetectedModel[] {
  const stdout = readFileSync(
    join(import.meta.dirname, '../../fixtures/opencode/models-verbose.txt'),
    'utf8',
  );
  const catalog = parseOpenCodeNativeModelCatalog(stdout);
  if (catalog === null) throw new Error('opencode/models-verbose.txt did not parse');
  return nativeCliCatalogToDetectedModels(catalog);
}

function kiloVerboseModels(): readonly DetectedModel[] {
  const stdout = readFileSync(
    join(import.meta.dirname, '../../fixtures/kilo/models-verbose.txt'),
    'utf8',
  );
  const catalog = parseKiloNativeModelCatalog(stdout);
  if (catalog === null) throw new Error('kilo/models-verbose.txt did not parse');
  return nativeCliCatalogToDetectedModels(catalog);
}

function copilotHelpConfigModels(): readonly DetectedModel[] {
  const stdout = readFileSync(
    join(import.meta.dirname, '../../fixtures/copilot/help-config.txt'),
    'utf8',
  );
  const catalog = parseCopilotHelpConfigCatalog(stdout);
  if (catalog === null) throw new Error('copilot/help-config.txt did not parse');
  return nativeCliCatalogToDetectedModels(catalog);
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
    connection: { tool: input.tool, contextKey: `planner-${input.tool}-visual` },
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

function seedConfig(overrides?: VisualConfigOverrides): OverlaySeed {
  return () => seedVisualConfig(overrides);
}

function seedOpencodeCatalog(extraModels: readonly DetectedModel[] = []): void {
  // OpenCode's routes are one fact: the `opencode` provider block of the
  // models.dev slice. A second hand-written list drifts from it silently, since
  // an unmatched id just renders without metadata.
  const routes = modelsDevSlice().opencode?.models;
  if (routes === undefined) throw new Error('models-dev-slice.json has no opencode provider');
  seedConfig({ planner: { kind: 'cli', tool: 'opencode', model: OPENCODE_ROUTED_MODEL } })();
  const extras = new Map(extraModels.map((model) => [model.id, model]));
  const routeIds = Object.keys(routes);
  publishVisualDiscovery({
    cliTools: [cliDetectionFor('ready', 'opencode')],
    cliModels: [
      catalogAttempt({
        tool: 'opencode',
        outcome: {
          kind: 'success',
          value: [
            ...routeIds.map((id) => extras.get(id) ?? { id }),
            ...extraModels.filter((model) => routeIds.some((id) => model.id.startsWith(`${id}-`))),
          ],
        },
      }),
    ],
  });
  hydrateSlice();
}

function seedProviderAuth(
  arm: 'read' | 'empty' | 'unreadable',
  reason: CliProviderAuthUnreadableReason = 'parse-failure',
  extraModels: readonly DetectedModel[] = [],
): void {
  seedOpencodeCatalog(extraModels);
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

/**
 * The one detection an oracle tool can carry with no `providerAuth` at all: the
 * probe stops before the credential listing when the executable's identity no
 * longer matches, so the cached routes render with their sign-in state unread.
 */
function seedUnprobedOpencode(): void {
  seedOpencodeCatalog();
  const detection = detectionStore.get();
  detectionStore.setDetection({
    providers: [...detection.providers],
    cliTools: [
      ...detection.cliTools.filter((tool) => tool.tool !== 'opencode'),
      cliDetectionFor('untrusted', 'opencode'),
    ],
  });
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

function seedClaudeAliasRows(): void {
  seedConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'opus' } })();
  publishVisualDiscovery({
    cliTools: [cliDetectionFor('ready', 'claude-code')],
    modelsDev: { catalog: modelsDevSlice() },
  });
}

function seedImplementerClaudeCheapest(): void {
  seedConfig({
    implementer: { kind: 'cli', tool: 'claude-code', model: 'auto:cheapest' },
  })();
  publishVisualDiscovery({
    cliTools: [cliDetectionFor('ready', 'claude-code')],
    modelsDev: { catalog: modelsDevSlice() },
  });
}

/**
 * The one arm where the browse escape widens anything: a local runner with no
 * inventory of its own still has a models.dev lane, so the live lane hides the
 * bundled fallback row and the escape is what restores it.
 */
function seedOllamaCatalogLane(): void {
  seedConfig({
    implementer: {
      kind: 'api',
      provider: 'ollama',
      apiBase: 'http://localhost:11434/v1',
      model: 'gpt-oss:120b-cloud',
    },
  })();
  const slice = modelsDevSlice();
  const cloud = slice['ollama-cloud'];
  if (cloud === undefined) throw new Error('models-dev-slice.json has no ollama-cloud provider');
  detectionStore.setDetection({
    cliTools: [],
    providers: [{ provider: 'ollama', available: true, isLocal: true, hasKey: false, models: [] }],
  });
  modelCacheStore.setProviderModels('ollama', []);
  modelCacheStore.hydrateModelsDevCatalog({
    catalog: { ...slice, ollama: { ...cloud, id: 'ollama' } },
    fetchedAt: VISUAL_PUBLISHED_AT,
    validatedAt: VISUAL_PUBLISHED_AT,
  });
}

function seedCopilotNativeListing(): void {
  const models = copilotHelpConfigModels();
  const persisted = models[0]?.id ?? 'gpt-5.6-luna';
  seedConfig({ planner: { kind: 'cli', tool: 'copilot', model: persisted } })();
  publishVisualDiscovery({
    cliTools: [cliDetectionFor('ready', 'copilot')],
    cliModels: [catalogAttempt({ tool: 'copilot', outcome: { kind: 'success', value: models } })],
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

function seedKiloFreeRoutes(): void {
  const models = kiloVerboseModels();
  seedConfig({
    planner: { kind: 'cli', tool: 'kilo-code', model: 'kilo/kilo-auto/free' },
  })();
  publishVisualDiscovery({
    cliTools: [cliDetectionFor('ready', 'kilo-code')],
    cliModels: [catalogAttempt({ tool: 'kilo-code', outcome: { kind: 'success', value: models } })],
  });
}

function seedKiloMalformed(): void {
  seedConfig({ planner: { kind: 'cli', tool: 'kilo-code', model: 'kilo/kilo-auto/free' } })();
  publishVisualDiscovery({
    cliTools: [cliDetectionFor('ready', 'kilo-code')],
    cliModels: [catalogAttempt({ tool: 'kilo-code', outcome: { kind: 'malformed' } })],
  });
}

/** The `(NO ZDR)` family the collapsed frame must show, and the family the expanded frame opens. */
const CURSOR_NO_ZDR_MODEL = 'claude-fable-5-high';
const CURSOR_FAMILY_MODEL = 'gpt-5.6-sol-high';
const CURSOR_FAMILY_DRAFT = 'gpt-5.6-sol-xhigh-fast';

function seedCursorConfirmed(persisted: string): void {
  seedConfig({ planner: { kind: 'cli', tool: 'cursor', model: persisted } })();
  publishVisualDiscovery({
    cliTools: [cliDetectionFor('ready', 'cursor')],
    cliModels: [
      catalogAttempt({
        tool: 'cursor',
        outcome: { kind: 'success', value: cursorDetectedModels() },
      }),
    ],
  });
}

function createOverlayFixture(options: {
  readonly overlay: OverlayType;
  readonly seed?: OverlaySeed;
  readonly underlyingScreen?: OverlayUnderlyingScreen;
  readonly focus?: string;
  readonly effortDraftAfterMount?: string;
}): FixtureLifecycle {
  const {
    overlay,
    seed = EMPTY_SEED,
    underlyingScreen = 'home',
    focus,
    effortDraftAfterMount,
  } = options;
  let stopReseed: (() => void) | undefined;
  return {
    setup: (context) => {
      setupVisualFixture(context);
      routerStore.init(
        underlyingScreen === 'workflow'
          ? { screen: 'workflow', execution: { kind: 'local', prepared: overlayPrepared() } }
          : { screen: underlyingScreen },
      );
      seedRunnerCatalog();
      seed();
      if (underlyingScreen === 'workflow') stopReseed = reseedAfterWorkflowReset(seed);
      else if (effortDraftAfterMount !== undefined) {
        stopReseed = restoreEffortDraftAfterMount(effortDraftAfterMount);
      }
      overlayStore.open(overlay, focus);
    },
    teardown: () => {
      stopReseed?.();
      stopReseed = undefined;
      teardownVisualFixture();
    },
  };
}

// The workflow screen resets the session-scoped stores in a mount
// effect (`use-runner.ts:135`), which runs after this fixture has seeded
// them — `resetWorkflow` clears the token totals a workflow overlay reads. The
// first token reset after setup is that wipe, so re-apply the seed there.
function reseedAfterWorkflowReset(seed: OverlaySeed): () => void {
  const stop = tokensStore.subscribe(() => {
    stop();
    seed();
  });
  return stop;
}

/**
 * The picker's left column re-notifies its current item from a mount layout effect
 * (`use-column-state.ts:74`), and `leftChange` clears the effort draft — so a level seeded
 * before mount is wiped before the first paint. The first clear after setup is that wipe;
 * re-apply the level there.
 */
function restoreEffortDraftAfterMount(level: string): () => void {
  let stopped = false;
  const stop = pickerViewStore.subscribe(() => {
    if (stopped || pickerViewStore.get().effortDraft !== null) return;
    stopped = true;
    stop();
    pickerViewStore.setEffortDraft(level);
  });
  return () => {
    if (stopped) return;
    stopped = true;
    stop();
  };
}

const REVIEWER_SEAT = { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' } as const;
const REVIEWER_API_SEAT = {
  kind: 'api',
  provider: 'custom-endpoint',
  model: 'o3',
  apiBase: 'https://api.example.test/v1',
  effort: 'high',
} as const;
const ESCALATION_SEAT = {
  intermediateProvider: 'custom-endpoint',
  intermediateModel: 'custom-chat',
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
/** Kilo spends its effort on `--variant`, Copilot on `--effort`: the two channels this crew block
 * has no other scenario for. */
const PLANNER_KILO_SEAT = {
  kind: 'cli',
  tool: 'kilo-code',
  model: 'openai/gpt-5.6',
} as const;
const BUILD_COPILOT_SEAT = {
  kind: 'cli',
  tool: 'copilot',
  model: 'gpt-5.6-luna',
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
    focus: 'seat:review',
  });
const createSettingsCrewKiloCopilotFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'settings',
    seed: seedConfig({ planner: PLANNER_KILO_SEAT, implementer: BUILD_COPILOT_SEAT }),
    focus: 'seat:plan',
  });
const createSettingsBuildAutoCheapestFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'settings',
    seed: seedImplementerClaudeCheapest,
    focus: 'seat:build',
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
// The Workflow section scrolls off an unfiltered Settings below 120 columns, and its two
// policy rows (`Spec/plan gates`, `Commit strategy`) are the ones that read as a value only
// when they are unset — so one scenario holds that section on screen at every width.
const createSettingsFilterWorkflowFixture: FixtureFactory = () =>
  createOverlayFixture({ overlay: 'settings', focus: 'filter:workflow' });
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
const createOpencodeExpandedFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: () => {
      seedProviderAuth('read', 'parse-failure', opencodeVerboseModels());
      pickerViewStore.expand(OPENCODE_ROUTED_MODEL, OPENCODE_ROUTED_MODEL);
    },
    focus: OPENCODE_FOCUS,
  });
const createOpencodeExpandedDraftedFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: () => {
      seedProviderAuth('read', 'parse-failure', opencodeVerboseModels());
      pickerViewStore.expand(OPENCODE_ROUTED_MODEL, OPENCODE_ROUTED_MODEL, 'max');
    },
    focus: OPENCODE_FOCUS,
    effortDraftAfterMount: 'max',
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
      seedUnprobedOpencode();
      pickerViewStore.expand(OPENCODE_ROUTED_MODEL);
    },
    focus: OPENCODE_FOCUS,
  });
const createPlannerPickerColdFixture: FixtureFactory = () =>
  createOverlayFixture({ overlay: 'planner-picker', seed: seedModelsDevLane('uninitialized') });
const createPlannerPickerNoListingFixture: FixtureFactory = () =>
  createOverlayFixture({ overlay: 'planner-picker', seed: seedClaudeCodeUnsupported });
const createClaudeEffortFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: () => {
      seedConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'opus' } })();
      seedClaudeCodeUnsupported();
      pickerViewStore.expand('opus');
    },
    focus: 'tool:claude-code',
  });
const createClaudeEffortSetFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: () => {
      // Without the config the persisted model stays the base planner's claude-sonnet-4 and both
      // the check and the cursor land twelve rows below Opus.
      seedConfig({
        planner: { kind: 'cli', tool: 'claude-code', model: 'opus', effort: 'high' },
      })();
      seedClaudeCodeUnsupported();
      pickerViewStore.expand('opus', undefined, 'high');
    },
    // The token the hook reads for the seat-axis landing — NOT 'tool:claude-code'. The left column
    // still lands on claude-code through the configured item, and the cursor lands on the effort axis.
    focus: seatAxisFocus('plan'),
    effortDraftAfterMount: 'high',
  });
const createPlannerPickerKiloFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: seedKiloConfirmed,
    focus: 'tool:kilo-code',
  });
const createPlannerPickerKiloFreeFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: seedKiloFreeRoutes,
    focus: 'tool:kilo-code',
  });
const createPlannerPickerMalformedFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: seedKiloMalformed,
    focus: 'tool:kilo-code',
  });
const createPlannerPickerCursorFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: () => seedCursorConfirmed(CURSOR_NO_ZDR_MODEL),
    focus: 'tool:cursor',
  });
const createCursorExpandedFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: () => {
      seedCursorConfirmed(CURSOR_FAMILY_MODEL);
      pickerViewStore.expand(CURSOR_FAMILY_MODEL, CURSOR_FAMILY_DRAFT);
    },
    focus: 'tool:cursor',
  });
const createPlannerPickerClaudeFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: seedClaudeAliasRows,
    focus: 'tool:claude-code',
  });
const createPlannerPickerCopilotFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: seedCopilotNativeListing,
    focus: 'tool:copilot',
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
const createImplementerPickerFixture: FixtureFactory = () =>
  createOverlayFixture({ overlay: 'implementer-picker' });
const createPickerBrowseEscapeFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'implementer-picker',
    seed: seedOllamaCatalogLane,
    focus: 'tool:ollama',
  });
const createBuildPickerAutoCheapestFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'implementer-picker',
    seed: seedImplementerClaudeCheapest,
    focus: 'tool:claude-code',
  });
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
  [scenarioId('overlay-settings-crew-kilo-copilot'), createSettingsCrewKiloCopilotFixture],
  [scenarioId('overlay-settings-build-auto-cheapest'), createSettingsBuildAutoCheapestFixture],
  [scenarioId('overlay-settings-floor-full'), createSettingsFloorFullFixture],
  [scenarioId('overlay-settings-filtered'), createSettingsFilteredFixture],
  [scenarioId('overlay-settings-filter-plan'), createSettingsFilterPlanFixture],
  [scenarioId('overlay-settings-filter-workflow'), createSettingsFilterWorkflowFixture],
  [scenarioId('overlay-mode-selector'), createModeSelectorFixture],
  [scenarioId('overlay-planner-picker'), createPlannerPickerFixture],
  [scenarioId('overlay-planner-picker-catalog'), createPlannerPickerCatalogFixture],
  [scenarioId('overlay-picker-provider-expanded-read'), createProviderExpandedReadFixture],
  [scenarioId('overlay-picker-opencode-expanded'), createOpencodeExpandedFixture],
  [scenarioId('overlay-picker-opencode-expanded-drafted'), createOpencodeExpandedDraftedFixture],
  [scenarioId('overlay-picker-claude-effort'), createClaudeEffortFixture],
  [scenarioId('overlay-picker-claude-effort-set'), createClaudeEffortSetFixture],
  [scenarioId('overlay-picker-provider-expanded-empty'), createProviderExpandedEmptyFixture],
  [
    scenarioId('overlay-picker-provider-expanded-unreadable'),
    createProviderExpandedUnreadableFixture,
  ],
  [scenarioId('overlay-picker-routes-unchecked'), createRoutesUncheckedFixture],
  [scenarioId('overlay-planner-picker-cold'), createPlannerPickerColdFixture],
  [scenarioId('overlay-planner-picker-no-listing'), createPlannerPickerNoListingFixture],
  [scenarioId('overlay-planner-picker-kilo'), createPlannerPickerKiloFixture],
  [scenarioId('overlay-planner-picker-kilo-free'), createPlannerPickerKiloFreeFixture],
  [scenarioId('overlay-planner-picker-malformed'), createPlannerPickerMalformedFixture],
  [scenarioId('overlay-planner-picker-claude'), createPlannerPickerClaudeFixture],
  [scenarioId('overlay-planner-picker-copilot'), createPlannerPickerCopilotFixture],
  [scenarioId('overlay-planner-picker-cursor'), createPlannerPickerCursorFixture],
  [scenarioId('overlay-picker-cursor-expanded'), createCursorExpandedFixture],
  [scenarioId('overlay-picker-contract-choice'), createContractChoiceFixture],
  [scenarioId('overlay-picker-custom-command'), createCustomCommandFixture],
  [scenarioId('overlay-picker-custom-model'), createCustomModelFixture],
  [scenarioId('overlay-implementer-picker'), createImplementerPickerFixture],
  [scenarioId('overlay-picker-browse-escape'), createPickerBrowseEscapeFixture],
  [scenarioId('overlay-build-picker-auto-cheapest'), createBuildPickerAutoCheapestFixture],
  [scenarioId('overlay-reviewer-picker-inherited'), createReviewerPickerFixture],
  [scenarioId('overlay-reviewer-picker-tool'), createReviewerPickerToolFixture],
  [scenarioId('overlay-sessions'), createSessionsFixture],
  [scenarioId('overlay-editor'), createEditorFixture],
  [scenarioId('overlay-cost-drilldown'), createCostDrilldownFixture],
]);
