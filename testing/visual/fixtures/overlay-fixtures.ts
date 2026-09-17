import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OverlayType } from '../../../src/core/navigation/types.js';
import {
  API_PROVIDER_CATALOG,
  type ApiProviderId,
} from '../../../src/core/providers/api-provider-catalog.js';
import type {
  ProviderCatalogFailureKind,
  ProviderCatalogOutcome,
} from '../../../src/engine/providers/types.js';
import type { SeatPickerRole } from '../../../src/core/runners/seat-roles.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import type {
  CliProviderAuth,
  CliProviderAuthUnreadableReason,
  DetectedModel,
} from '../../../src/core/discovery/detection.js';
import {
  nativeCliCatalogToDetectedModels,
  parseAntigravityModelCatalog,
  parseCopilotHelpConfigCatalog,
  parseKiloNativeModelCatalog,
  parseOpenCodeNativeModelCatalog,
} from '../../../src/engine/providers/cli-model-catalog.js';
import { ModelsDevCatalogSchema } from '../../../src/core/schemas/models-dev.js';
import type { RecoveryIssue } from '../../../src/core/schemas/recovery/schemas.js';
import type { CostBreakdown } from '../../../src/core/schemas/summary.js';
import { ZERO_TOKEN_USAGE } from '../../../src/core/schemas/tokens.js';
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
import { addEvent } from '../../../src/stores/workflow/actions/event.js';
import { taskId } from '../../../src/core/schemas/task.js';
import { reviewStore } from '../../../src/stores/workflow/review.js';
import { tokensStore } from '../../../src/stores/workflow/tokens.js';
import { routerStore, type RouteData } from '../../../src/stores/navigation/router.js';
import { prepareWorkflowExecution } from '../../helpers/workflow-screen.js';
import { makeRunRecord } from '../../helpers/factories/run-record.js';
import { scenarioId } from '../contracts/identifiers.js';
import { cursorDetectedModels } from '../../helpers/factories/cursor-models.js';
import { cliDetectionFor } from '../../helpers/factories/detection.js';
import { makeSession } from '../../helpers/factories/session.js';
import { makeSummary } from '../../helpers/factories/summary.js';
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

/** The run behind an overlay: one record, and the execution driving it, exactly as a run starts. */
function overlayWorkflowRoute(): RouteData {
  const prepared = overlayPrepared();
  return {
    screen: 'workflow',
    run: makeRunRecord({ ref: prepared.session.ref, feature: prepared.runtime.feature }),
    execution: { kind: 'local', prepared },
  };
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
    }),
  });
  // The sessions overlay re-reads the project directory on mount, so the
  // session has to exist on disk to survive to the capture.
  const dir = join(sessionsRoot(VISUAL_FIXTURE_PROJECT_DIR), session.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(session));
  sessionsStore.__testReset({ sessions: [session], totalCount: 1 });
}

function seedEditor(): void {
  const filePath = 'fixtures/visual-session/tasks.md';
  const ownerToken = reviewStore.setReviewFile(filePath, 8);
  editorStore.openRaw({
    filePath,
    ownerToken,
    value: [
      '---',
      'id: T001',
      'title: Add greeting helper',
      'action: modify',
      'file: src/greet.ts',
      'files: [src/greet.ts, src/greet.test.ts]',
      'depends_on: []',
      '---',
      '',
      '### Description',
      'Add a helper that returns a friendly greeting string.',
    ].join('\n'),
    layout: { columns: 72, rows: 19 },
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

// Three native rows: one models.dev knows by its bare id under another owner, one it does not know
// at all, and one from a vendor it has never heard of. Between them the picker has to show a
// catalog name, a bare id, and the words for "no catalog entry" on the same list.
const COMMAND_CODE_MODELS: readonly DetectedModel[] = [
  {
    id: 'deepseek/deepseek-v4-flash',
    nativeOrder: 0,
    detail: 'fast hybrid-attention reasoning',
    nativeDefault: true,
  },
  { id: 'deepseek/deepseek-v4', nativeOrder: 1 },
  { id: 'acme/private-preview-1', nativeOrder: 2 },
];

// models.dev serves DeepSeek under its own vendor id; the shared slice carries the model only under
// Ollama Cloud, so the vendor the picker looks up is added here rather than widening the slice.
function commandCodeModelsDevCatalog(): ReturnType<typeof ModelsDevCatalogSchema.parse> {
  return ModelsDevCatalogSchema.parse({
    ...modelsDevSlice(),
    deepseek: {
      id: 'deepseek',
      name: 'DeepSeek',
      models: {
        'deepseek-v4-flash': {
          id: 'deepseek-v4-flash',
          name: 'DeepSeek V4 Flash',
          limit: { context: 128_000, output: 64_000 },
          release_date: '2026-01-12',
          modalities: { input: ['text'], output: ['text'] },
        },
      },
    },
  });
}

function seedCommandCodeNativeListing(): void {
  seedConfig({
    planner: { kind: 'cli', tool: 'command-code', model: 'deepseek/deepseek-v4-flash' },
  })();
  publishVisualDiscovery({
    cliTools: [cliDetectionFor('ready', 'command-code')],
    cliModels: [
      catalogAttempt({
        tool: 'command-code',
        outcome: { kind: 'success', value: [...COMMAND_CODE_MODELS] },
      }),
    ],
    modelsDev: { catalog: commandCodeModelsDevCatalog() },
  });
}

// `agy models` lists one row per effort variant (`gemini-3.8-flash-high`); the picker merges the
// variants into one family row whose expanded child is the effort axis, so the render only tells
// the truth when it is fed the real listing.
function antigravityModels(): readonly DetectedModel[] {
  const stdout = readFileSync(
    join(import.meta.dirname, '../../fixtures/antigravity/models.txt'),
    'utf8',
  );
  const catalog = parseAntigravityModelCatalog(stdout);
  if (catalog === null) throw new Error('antigravity/models.txt did not parse');
  return nativeCliCatalogToDetectedModels(catalog);
}

function seedAntigravityNativeListing(): void {
  seedConfig({
    planner: {
      kind: 'cli',
      tool: 'antigravity',
      model: 'gemini-3.8-flash-medium',
      effort: 'medium',
    },
  })();
  publishVisualDiscovery({
    cliTools: [cliDetectionFor('ready', 'antigravity')],
    cliModels: [
      catalogAttempt({
        tool: 'antigravity',
        outcome: { kind: 'success', value: [...antigravityModels()] },
      }),
    ],
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
  /** The workflow route to open on, when the ordinary live run is not the one the frame is about. */
  readonly workflowRoute?: () => RouteData;
  readonly focus?: string;
  readonly effortDraftAfterMount?: string;
}): FixtureLifecycle {
  const {
    overlay,
    seed = EMPTY_SEED,
    underlyingScreen = 'home',
    workflowRoute = overlayWorkflowRoute,
    focus,
    effortDraftAfterMount,
  } = options;
  let stopReseed: (() => void) | undefined;
  return {
    setup: (context) => {
      setupVisualFixture(context);
      routerStore.init(
        underlyingScreen === 'workflow' ? workflowRoute() : { screen: underlyingScreen },
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
  createOverlayFixture({
    overlay: 'command-palette',
    underlyingScreen: 'workflow',
    seed: seedSkills,
  });
const createSkillsFixture: FixtureFactory = () =>
  createOverlayFixture({ overlay: 'skills', seed: seedSkills });
const createSkillsEmptyFixture: FixtureFactory = () => createOverlayFixture({ overlay: 'skills' });
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
const createPlannerPickerCommandCodeFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: seedCommandCodeNativeListing,
    focus: 'tool:command-code',
  });
const createPlannerPickerAntigravityFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: () => {
      seedAntigravityNativeListing();
      pickerViewStore.expand('gemini-3.8-flash-medium', 'gemini-3.8-flash-medium', 'medium');
    },
    focus: 'tool:antigravity',
    effortDraftAfterMount: 'medium',
  });
// The launcher's read-only card is what the cursor opens on this row, so the
// fixture parks there with nothing configured — the state the card guides.
const createCustomCommandLauncherFixture: FixtureFactory = () =>
  createOverlayFixture({ overlay: 'planner-picker', focus: 'tool:custom-command' });
/** Nothing is listening on the loopback port, so the seat has no catalog to choose from. */
function seedStoppedOllama(): void {
  const cliTools = [...detectionStore.get().cliTools];
  // The catalog and the detection share one store, so the remembered models go first.
  modelCacheStore.reset();
  detectionStore.setDetection({
    cliTools,
    providers: [
      {
        provider: 'ollama',
        available: false,
        isLocal: true,
        hasKey: false,
        failure: 'offline',
        error: 'connect ECONNREFUSED 127.0.0.1:11434',
      },
    ],
  });
}

// Offline servers keep a reachable entry, followed by the editable connection form.
const createLocalServerFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: seedStoppedOllama,
    focus: 'tool:ollama',
  });

function localConnectionFixture(
  input: {
    provider?: ApiProviderId;
    role?: SeatPickerRole;
    failure?: Extract<
      ProviderCatalogFailureKind,
      | 'offline'
      | 'timeout'
      | 'invalid-credential'
      | 'malformed'
      | 'endpoint-invalid'
      | 'request-failed'
    >;
    models?: readonly DetectedModel[];
    selectedModel?: string;
  } = {},
): FixtureLifecycle {
  const provider = input.provider ?? 'ollama';
  const role = input.role ?? 'planner';
  const policy = API_PROVIDER_CATALOG[provider].endpointPolicy;
  if (policy.kind !== 'loopback') throw new Error('Local fixture requires a loopback profile');
  const fixture = createOverlayFixture({
    overlay: `${role}-picker`,
    focus: `tool:${provider}`,
    seed: () => {
      seedVisualConfig({
        [role]: {
          kind: 'api',
          provider,
          apiBase: policy.defaultBaseURL,
          model: input.selectedModel ?? 'qwen2.5-coder:7b',
          contextLength: 32_768,
        },
      });
      pickerViewStore.open({ kind: 'local-connection', provider });
    },
  });
  if (input.failure === undefined && input.models === undefined) return fixture;
  const outcome: ProviderCatalogOutcome =
    input.failure !== undefined
      ? {
          kind: 'failed',
          source: 'provider-runtime',
          provider,
          isLocal: true,
          credential: 'not-required',
          failure: input.failure,
          diagnostic:
            {
              offline: 'The server is not running.',
              timeout: 'The catalog request timed out.',
              'invalid-credential': 'The configured token was refused.',
              malformed: 'The server returned an unreadable catalog.',
              'endpoint-invalid': 'The server refused this endpoint.',
              'request-failed': 'The request failed without a more specific diagnosis.',
            }[input.failure] ?? 'The catalog check failed.',
        }
      : {
          kind: 'success',
          source: 'provider-runtime',
          provider,
          isLocal: true,
          credential: 'not-required',
          catalog: input.models?.length === 0 ? 'empty' : 'populated',
          models: input.models ?? [],
        };
  return { ...fixture, connectionOutcome: outcome, afterMount: (write) => write('\r') };
}

const createAuthConfigOwnedFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    focus: OPENCODE_FOCUS,
    seed: () => {
      seedProviderAuth('read');
      pickerViewStore.expand(OPENCODE_ROUTED_MODEL);
    },
  });

const createAuthUnsupportedFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    focus: 'tool:claude-code',
    seed: () => {
      seedClaudeAliasRows();
      seedVisualConfig({
        planner: {
          kind: 'cli',
          tool: 'claude-code',
          model: 'opus',
          authChannel: 'api-key',
        },
      });
      pickerViewStore.expand('opus');
    },
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
const createReviewerPickerFixture: FixtureFactory = () =>
  createOverlayFixture({ overlay: 'reviewer-picker' });
const createReviewerPickerToolFixture: FixtureFactory = () =>
  createOverlayFixture({ overlay: 'reviewer-picker', focus: 'tool:codex' });
const STOP_SHEET_TS = 1_783_958_400_000;
const STOP_SHEET_RUNNING = taskId('T002');
const STOP_SHEET_NEXT = taskId('T003');

// The sheet's pause row names the brief it would finish and the one it would not start, so the run
// underneath it has to have both.
function seedStopSheet(): void {
  addEvent({
    type: 'tasks_planned',
    ts: STOP_SHEET_TS,
    phase: 'implementing',
    total: 3,
    tasks: [
      {
        id: taskId('T001'),
        title: 'Add the stop sheet rows',
        index: 0,
        file: 'src/features/workflow/stop/options.ts',
        action: 'create',
      },
      {
        id: STOP_SHEET_RUNNING,
        title: 'Render the stop sheet',
        index: 1,
        file: 'src/features/workflow/stop/sheet.tsx',
        action: 'create',
      },
      {
        id: STOP_SHEET_NEXT,
        title: 'Route the stop overlay',
        index: 2,
        file: 'src/app/router.tsx',
        action: 'modify',
      },
    ],
  });
  addEvent({
    type: 'task_started',
    ts: STOP_SHEET_TS + 100,
    phase: 'implementing',
    taskId: STOP_SHEET_RUNNING,
    title: 'Render the stop sheet',
    index: 1,
    total: 3,
    file: 'src/features/workflow/stop/sheet.tsx',
    action: 'create',
    tool: 'ollama',
    model: 'fixture-model-v1',
  });
}

const createStopSheetFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'stop-sheet',
    seed: seedStopSheet,
    underlyingScreen: 'workflow',
  });
const createSessionsFixture: FixtureFactory = () =>
  createOverlayFixture({ overlay: 'sessions', seed: seedSessions });
const USAGE_TS = 1_783_958_400_000;

/**
 * A run read back from disk, so its money is the breakdown the engine recorded at the rates the
 * calls actually ran at — the only place a per-request estimate and its rate provenance exist.
 */
function usageRoute(costBreakdown: CostBreakdown): () => RouteData {
  return () => ({
    screen: 'workflow',
    run: makeRunRecord({
      ref: { projectDir: VISUAL_FIXTURE_PROJECT_DIR, sessionId: '2026-09-14-usage' },
      feature: 'Report what each seat spent',
      status: {
        kind: 'open',
        stop: { kind: 'paused', at: 'boundary' },
        resumeAt: { kind: 'planner', call: 'tasks' },
      },
      summary: makeSummary({ feature: 'Report what each seat spent', costBreakdown }),
    }),
    execution: { kind: 'at-rest' },
  });
}

/**
 * A review packet the seat could not hold, persisted with the halt and read back off the run's own
 * record — the diagnosis a reopened run still has. Every figure the refusal compared is here; the
 * panel that raised it carries none of them.
 */
const USAGE_CONTEXT_HALT: RecoveryIssue = {
  id: 'rec_visual_api_context',
  reason: 'review-failed',
  seat: 'review',
  phase: 'final-review',
  status: 'awaiting-user',
  files: [],
  affectedTaskIds: [],
  message: 'The review seat was not given the context this call needs.',
  details: ['Adjust the review seat with /crew review or Settings, then /resume and choose retry.'],
  facts: {
    apiContextCode: 'insufficient-context',
    apiContextSeat: 'review',
    apiContextCause: 'input-budget',
    apiContextModel: 'qwen3-coder-30b',
    apiContextMissingSectionsJson: '[]',
    reviewFailureKind: 'insufficient-context',
    apiContextInputEstimate: 404_000,
    apiContextEstimationMargin: 4_000,
    apiContextRequiredOutputTokens: 4_096,
    apiContextRequiredTokens: 412_096,
    apiContextAvailableTokens: 32_768,
    apiContextOutputCap: 8_192,
  },
  availableActions: ['retry-same-worker', 'pause-run', 'end-run'],
  recommendedAction: 'pause-run',
  createdAt: '2026-09-14T00:00:00.000Z',
};

/** The same run, stopped on that halt: `deriveRunStatus` is what carries the issue to the page. */
function usageContextRoute(): RouteData {
  return {
    screen: 'workflow',
    run: makeRunRecord({
      ref: { projectDir: VISUAL_FIXTURE_PROJECT_DIR, sessionId: '2026-09-14-usage' },
      feature: 'Review the bounded fixture branch',
      status: {
        kind: 'open',
        stop: { kind: 'halted', issue: USAGE_CONTEXT_HALT },
        resumeAt: { kind: 'review', cycle: 0 },
      },
      summary: makeSummary({
        feature: 'Review the bounded fixture branch',
        costBreakdown: USAGE_PRICED_BREAKDOWN,
      }),
    }),
    execution: { kind: 'at-rest' },
  };
}

/** The crew the recorded breakdown was priced for, so the run on screen and its record agree. */
const USAGE_CREW: VisualConfigOverrides = {
  planner: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4-5' },
  implementer: { kind: 'cli', tool: 'codex', model: 'gpt-5.1-codex' },
};

/** The same crew with the local review seat the halt names, so the diagnosis and the run agree. */
const USAGE_CONTEXT_CREW: VisualConfigOverrides = {
  ...USAGE_CREW,
  reviewer: {
    kind: 'api',
    provider: 'ollama',
    model: 'qwen3-coder-30b',
    apiBase: 'http://127.0.0.1:11434/v1',
    contextLength: 32_768,
  },
};

function seedUsageContextCounters(): void {
  seedUsageCounters();
  seedVisualConfig(USAGE_CONTEXT_CREW);
}

/** Two seats that reported different amounts of what they spent: neither is filled out for it. */
function seedUsageCounters(): void {
  seedVisualConfig(USAGE_CREW);
  addEvent({
    type: 'cost_update',
    ts: USAGE_TS,
    phase: 'implementing',
    tokenUsage: {
      ...ZERO_TOKEN_USAGE,
      plannerInput: 124_000,
      plannerOutput: 32_000,
      plannerCacheRead: 90_400,
      plannerReasoning: 8_100,
      plannerCoverage: {
        input: 'reported',
        output: 'reported',
        cacheRead: 'reported',
        cacheCreate: 'missing',
        reasoning: 'reported',
      },
      implementerInput: 812_000,
      implementerOutput: 190_500,
      implementerCoverage: {
        input: 'reported',
        output: 'reported',
        cacheRead: 'missing',
        cacheCreate: 'missing',
        reasoning: 'missing',
      },
    },
  });
}

function seedLegacyUsageCounters(): void {
  seedVisualConfig(USAGE_CREW);
  addEvent({
    type: 'cost_update',
    ts: USAGE_TS,
    phase: 'implementing',
    tokenUsage: { ...ZERO_TOKEN_USAGE, plannerInput: 9_800, plannerOutput: 1_200 },
  });
}

/** One priced request, one the missing cache rate left incomplete, and two billing postures. */
const USAGE_PRICED_BREAKDOWN: CostBreakdown = {
  actualPlannerCost: 0.42,
  actualImplementerCost: 1.18,
  totalActualCost: 1.6,
  hasPricedUsage: true,
  requestEstimate: {
    amount: null,
    currency: 'USD',
    basis: 'catalog-estimate',
    completeness: 'partial',
    knownSubtotal: 1.6,
    reasons: ['reasoning-not-reported', 'missing-cache-rate'],
    items: [
      {
        callId: 'call-planner-1',
        role: 'planner',
        usageBoundary: 'single-request',
        amount: 0.42,
        knownSubtotal: 0.42,
        completeness: 'complete',
        reasons: [],
        billing: { posture: 'api-metered', basis: 'enforced-channel' },
        rates: {
          source: 'models-dev',
          provider: 'anthropic',
          model: 'claude-sonnet-4-5',
          inputPer1M: 3,
          outputPer1M: 15,
          cacheReadPer1M: 0.3,
          capturedAt: VISUAL_PUBLISHED_AT,
          rateAsOf: '2026-06-01',
        },
      },
      {
        callId: 'call-implementer-1',
        role: 'implementer',
        usageBoundary: 'single-request',
        amount: null,
        knownSubtotal: 1.18,
        completeness: 'partial',
        reasons: ['missing-cache-rate'],
        billing: { posture: 'api-metered', basis: 'observed-invocation' },
        rates: {
          source: 'bundled-fallback',
          provider: 'openai',
          model: 'gpt-5.1-codex',
          inputPer1M: 1.25,
          outputPer1M: 10,
          selectedThresholdTokens: 200_000,
          capturedAt: VISUAL_PUBLISHED_AT,
        },
      },
    ],
  },
  providerRunMetadata: {
    'claude-code': {
      service: 'claude-code',
      offering: 'payg',
      normalizedEndpoint: 'cli://claude-code',
      billing: 'api-metered',
      asOf: '2026-01-01',
      billingAttribution: {
        posture: 'api-metered',
        basis: 'enforced-channel',
        evidenceId: 'cli.claude-code.api-key',
      },
    },
    codex: {
      service: 'codex',
      offering: 'coding-subscription',
      normalizedEndpoint: 'cli://codex',
      billing: 'subscription-included',
      asOf: '2026-01-01',
      billingAttribution: { posture: 'unknown', basis: 'unknown' },
    },
  },
};

/** A sum kept before per-request pricing existed: an amount with no rates and no provenance. */
const USAGE_LEGACY_BREAKDOWN: CostBreakdown = {
  actualPlannerCost: 0.3,
  actualImplementerCost: 0,
  totalActualCost: 0.3,
  hasPricedUsage: true,
};

const createUsageDetailsFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'usage-details',
    seed: seedUsageCounters,
    underlyingScreen: 'workflow',
    workflowRoute: usageRoute(USAGE_PRICED_BREAKDOWN),
  });
const createUsageDetailsLegacyFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'usage-details',
    seed: seedLegacyUsageCounters,
    underlyingScreen: 'workflow',
    workflowRoute: usageRoute(USAGE_LEGACY_BREAKDOWN),
  });
const createUsageContextFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'usage-details',
    seed: seedUsageContextCounters,
    underlyingScreen: 'workflow',
    workflowRoute: usageContextRoute,
  });
const createEditorFixture: FixtureFactory = () =>
  createOverlayFixture({ overlay: 'editor', seed: seedEditor, underlyingScreen: 'workflow' });

export const overlayFixtureRegistry: FixtureRegistry = new Map([
  [scenarioId('overlay-help'), createHelpFixture],
  [scenarioId('overlay-command-palette'), createPaletteFixture],
  [scenarioId('overlay-skills'), createSkillsEmptyFixture],
  [scenarioId('overlay-skills-list'), createSkillsFixture],
  [scenarioId('overlay-settings'), createSettingsFixture],
  [scenarioId('overlay-settings-crew-full'), createSettingsCrewFullFixture],
  [scenarioId('overlay-settings-inherited-effort'), createSettingsInheritedEffortFixture],
  [scenarioId('overlay-settings-crew-kilo-copilot'), createSettingsCrewKiloCopilotFixture],
  [scenarioId('overlay-settings-floor-full'), createSettingsFloorFullFixture],
  [scenarioId('overlay-settings-filtered'), createSettingsFilteredFixture],
  [scenarioId('overlay-settings-filter-plan'), createSettingsFilterPlanFixture],
  [scenarioId('overlay-settings-filter-workflow'), createSettingsFilterWorkflowFixture],
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
  [scenarioId('overlay-planner-picker-command-code'), createPlannerPickerCommandCodeFixture],
  [scenarioId('overlay-planner-picker-antigravity'), createPlannerPickerAntigravityFixture],
  [scenarioId('overlay-planner-picker-cursor'), createPlannerPickerCursorFixture],
  [scenarioId('overlay-picker-cursor-expanded'), createCursorExpandedFixture],
  [scenarioId('overlay-picker-custom-launcher'), createCustomCommandLauncherFixture],
  [scenarioId('overlay-picker-local-server'), createLocalServerFixture],
  [scenarioId('overlay-local-connection-ollama'), () => localConnectionFixture()],
  [
    scenarioId('overlay-local-connection-lmstudio'),
    () => localConnectionFixture({ provider: 'lm-studio', role: 'implementer' }),
  ],
  [
    scenarioId('overlay-local-connection-llamacpp'),
    () => localConnectionFixture({ provider: 'llama-cpp', role: 'reviewer' }),
  ],
  [
    scenarioId('overlay-local-connection-offline'),
    () => localConnectionFixture({ failure: 'offline' }),
  ],
  [
    scenarioId('overlay-local-connection-timeout'),
    () => localConnectionFixture({ failure: 'timeout' }),
  ],
  [
    scenarioId('overlay-local-connection-unauthorized'),
    () => localConnectionFixture({ provider: 'lm-studio', failure: 'invalid-credential' }),
  ],
  [
    scenarioId('overlay-local-connection-invalid'),
    () => localConnectionFixture({ failure: 'endpoint-invalid' }),
  ],
  [
    scenarioId('overlay-local-connection-unknown'),
    () => localConnectionFixture({ failure: 'request-failed' }),
  ],
  [
    scenarioId('overlay-local-connection-malformed'),
    () => localConnectionFixture({ failure: 'malformed' }),
  ],
  [scenarioId('overlay-local-connection-empty'), () => localConnectionFixture({ models: [] })],
  [
    scenarioId('overlay-local-connection-missing'),
    () => localConnectionFixture({ models: [{ id: 'gemma3:27b' }] }),
  ],
  [
    scenarioId('overlay-local-connection-loaded'),
    () =>
      localConnectionFixture({
        provider: 'lm-studio',
        models: [
          {
            id: 'qwen2.5-coder:7b',
            runtime: { loadState: 'loaded', observedAt: VISUAL_PUBLISHED_AT },
          },
        ],
      }),
  ],
  [
    scenarioId('overlay-local-connection-not-loaded'),
    () =>
      localConnectionFixture({
        provider: 'lm-studio',
        models: [
          {
            id: 'qwen2.5-coder:7b',
            runtime: { loadState: 'not-loaded', observedAt: VISUAL_PUBLISHED_AT },
          },
        ],
      }),
  ],
  [
    scenarioId('overlay-local-connection-listed'),
    () => localConnectionFixture({ models: [{ id: 'qwen2.5-coder:7b' }] }),
  ],
  [scenarioId('overlay-picker-auth-config-owned'), createAuthConfigOwnedFixture],
  [scenarioId('overlay-picker-auth-unsupported'), createAuthUnsupportedFixture],
  [scenarioId('overlay-picker-contract-choice'), createContractChoiceFixture],
  [scenarioId('overlay-picker-custom-command'), createCustomCommandFixture],
  [scenarioId('overlay-picker-custom-model'), createCustomModelFixture],
  [scenarioId('overlay-implementer-picker'), createImplementerPickerFixture],
  [scenarioId('overlay-picker-browse-escape'), createPickerBrowseEscapeFixture],
  [scenarioId('overlay-reviewer-picker-inherited'), createReviewerPickerFixture],
  [scenarioId('overlay-reviewer-picker-tool'), createReviewerPickerToolFixture],
  [scenarioId('workflow-stop-sheet'), createStopSheetFixture],
  [scenarioId('overlay-sessions'), createSessionsFixture],
  [scenarioId('overlay-usage-details'), createUsageDetailsFixture],
  [scenarioId('overlay-usage-details-legacy'), createUsageDetailsLegacyFixture],
  [scenarioId('overlay-usage-context-insufficient'), createUsageContextFixture],
  [scenarioId('overlay-editor'), createEditorFixture],
]);
