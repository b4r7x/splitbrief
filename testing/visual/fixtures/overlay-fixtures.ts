import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type OverlayType, seatAxisFocus } from '../../../src/core/navigation/types.js';
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
  parseCodexNativeModelCatalog,
  parseCommandCodeNativeModelCatalog,
  parseCopilotHelpConfigCatalog,
  parseCursorNativeModelCatalog,
  parseKiloNativeModelCatalog,
} from '../../../src/engine/providers/cli-model-catalog.js';
import { resolveSeatDisplayName } from '../../../src/engine/providers/model/display-names.js';
import { ModelsDevCatalogSchema } from '../../../src/core/schemas/models-dev.js';
import type { RecoveryIssue } from '../../../src/core/schemas/recovery/schemas.js';
import type { CostBreakdown, Summary } from '../../../src/core/schemas/summary.js';
import type { EvidenceLedger } from '../../../src/core/schemas/evidence.js';
import type { Session } from '../../../src/core/schemas/session.js';
import { type Task, taskId } from '../../../src/core/schemas/task.js';
import { ZERO_TOKEN_USAGE } from '../../../src/core/schemas/tokens.js';
import { deriveRunStatus, type RunStatus } from '../../../src/core/sessions/run-status.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { SOFT_SEP } from '../../../src/core/separators.js';
import { formatSeatIdentity, type CrewSeatId } from '../../../src/core/crew/identity.js';
import { deriveFallbackRows } from '../../../src/core/crew/fallback.js';
import { deriveCrewRows } from '../../../src/core/crew/rows.js';
import { crewActivate, fallbackActivate } from '../../../src/features/crew/rows.js';
import { formatNeedsSignInSaveFeedback } from '../../../src/features/runners/picker-format.js';
import type { ScopedCliCatalogAttempt } from '../../../src/engine/detection/cli-catalog-outcomes.js';
import type { PreparedExecution } from '../../../src/engine/runners/prepared-execution.js';
import { trackActiveApply } from '../../../src/engine/orchestrator/session-lifecycle/shutdown.js';
import { configStore } from '../../../src/stores/project/config.js';
import { overlayStore } from '../../../src/stores/ui/overlay.js';
import { editorStore } from '../../../src/stores/ui/editor.js';
import { pickerViewStore } from '../../../src/stores/ui/picker-view.js';
import { detectionStore } from '../../../src/stores/project/detection.js';
import { sessionsStore } from '../../../src/stores/project/sessions.js';
import { skillsStore } from '../../../src/stores/project/skills.js';
import { modelCacheStore } from '../../../src/stores/discovery/model-cache/state.js';
import { addEvent } from '../../../src/stores/workflow/actions/event.js';
import { reviewStore } from '../../../src/stores/workflow/review.js';
import { stopStore } from '../../../src/stores/workflow/stop.js';
import { markWorkflowPaused } from '../../../src/stores/workflow/actions/pause.js';
import { feedbackStore } from '../../../src/stores/ui/feedback.js';
import {
  formatConfigSaveSuccess,
  reportConfigSaveFailure,
} from '../../../src/stores/project/save-feedback.js';
import { configError } from '../../../src/core/config/errors.js';
import { tokensStore } from '../../../src/stores/workflow/tokens.js';
import { routerStore, type RouteData } from '../../../src/stores/navigation/router.js';
import { prepareWorkflowExecution } from '../../helpers/workflow-screen.js';
import { makeRunRecord } from '../../helpers/factories/run-record.js';
import { makePlanProposal } from '../../helpers/factories/plan.js';
import { scenarioId } from '../contracts/identifiers.js';
import { cliDetectionFor } from '../../helpers/factories/detection.js';
import { makeSession } from '../../helpers/factories/session.js';
import { makeSummary } from '../../helpers/factories/summary.js';
import { makeTask } from '../../helpers/factories/task.js';
import { makeReviewFixInsertedEvents } from '../../helpers/events/task.js';
import { createEvidenceLedger } from '../../../src/core/evidence/ledger-state.js';
import { hashTaskBrief } from '../../../src/core/evidence/brief-hash.js';
import type { FixtureFactory, FixtureLifecycle, FixtureRegistry } from './common.js';
import { VISUAL_FIXTURE_EPOCH } from './common.js';
import {
  opencodeApiModels,
  opencodeConfigOnlyModels,
  publishVisualDiscovery,
  seedVisualConfig,
  seedRoutedCrew,
  setupVisualFixture,
  teardownVisualFixture,
  visualConfig,
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

// `kilo models --verbose` on kilo 7.0.49, 29 of its 132 blocks verbatim: each model a test names,
// enough free routes to scroll the kilo-free picker at 120x40, and one model per provider prefix.
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
    join(import.meta.dirname, '../../fixtures/copilot/help-config-1.0.83.txt'),
    'utf8',
  );
  const catalog = parseCopilotHelpConfigCatalog(stdout);
  if (catalog === null) throw new Error('copilot/help-config-1.0.83.txt did not parse');
  return nativeCliCatalogToDetectedModels(catalog);
}

function commandCodeListModels(): readonly DetectedModel[] {
  const stdout = readFileSync(
    join(import.meta.dirname, '../../fixtures/command-code/list-models-1.62.1.txt'),
    'utf8',
  );
  const catalog = parseCommandCodeNativeModelCatalog(stdout);
  if (catalog === null) throw new Error('command-code/list-models-1.62.1.txt did not parse');
  return nativeCliCatalogToDetectedModels(catalog);
}

function cursorListModels(): readonly DetectedModel[] {
  const stdout = readFileSync(
    join(import.meta.dirname, '../../fixtures/cursor/list-models-2026.09.18.txt'),
    'utf8',
  );
  const catalog = parseCursorNativeModelCatalog(stdout);
  if (catalog === null) throw new Error('cursor/list-models-2026.09.18.txt did not parse');
  return nativeCliCatalogToDetectedModels(catalog);
}

// `codex debug models` on codex-cli 0.155.1 with only the fields the codex schema reads.
// Its prompt text and tool settings are dropped as unread. Re-capture when the schema reads more.
function codexDebugModels(): readonly DetectedModel[] {
  const stdout = readFileSync(
    join(import.meta.dirname, '../../fixtures/codex/debug-models-0.155.1.json'),
    'utf8',
  );
  const catalog = parseCodexNativeModelCatalog(stdout);
  if (catalog === null) throw new Error('codex/debug-models-0.155.1.json did not parse');
  return nativeCliCatalogToDetectedModels(catalog);
}

function modelsDevSlice(): ReturnType<typeof ModelsDevCatalogSchema.parse> {
  const raw = readFileSync(
    join(import.meta.dirname, '../../fixtures/models-dev-slice.json'),
    'utf8',
  );
  return ModelsDevCatalogSchema.parse(JSON.parse(raw));
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

export function seedSessions(): void {
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
  const readySession = makeSession({
    id: 'visual-session-ready',
    feature: 'Validate the signup form',
    startedAt: 1_735_728_000_000,
    status: 'open',
    apply: 'ready',
  });
  const appliedSession = makeSession({
    id: 'visual-session-applied',
    feature: 'Add the export command',
    startedAt: 1_735_724_000_000,
    completedAt: 1_735_724_120_000,
    status: 'complete',
    apply: 'applied',
    summary: makeSummary({
      feature: 'Add the export command',
      totalTasks: 2,
      completedByLocal: 2,
      totalTime: 120_000,
    }),
  });
  const undoneSession = makeSession({
    id: 'visual-session-undone',
    feature: 'Rename the config loader',
    startedAt: 1_735_722_000_000,
    completedAt: 1_735_722_100_000,
    status: 'complete',
    apply: 'undone',
    summary: makeSummary({
      feature: 'Rename the config loader',
      totalTasks: 1,
      completedByLocal: 1,
      totalTime: 100_000,
    }),
  });
  const discardedSession = makeSession({
    id: 'visual-session-discarded',
    feature: 'Try the cache rewrite',
    startedAt: 1_735_720_000_000,
    completedAt: 1_735_720_090_000,
    status: 'ended',
    apply: 'discarded',
  });
  const waitingSession = makeSession({
    id: 'visual-session-waiting',
    feature: 'Apply the image export',
    startedAt: VISUAL_FIXTURE_EPOCH - 5 * 60_000,
    completedAt: VISUAL_FIXTURE_EPOCH - 20_000,
    status: 'open',
    stop: 'waiting-for-you',
  });
  const stoppedSession = makeSession({
    id: 'visual-session-stopped',
    feature: 'Split the settings page',
    startedAt: VISUAL_FIXTURE_EPOCH - 11 * 60_000,
    completedAt: VISUAL_FIXTURE_EPOCH - 33_000,
    status: 'open',
    stop: 'stopped',
  });
  const seatDownSession = makeSession({
    id: 'visual-session-seat-down',
    feature: 'Build the export on a seat that is signed out',
    startedAt: 1_735_738_000_000,
    status: 'open',
    stop: 'waiting-for-you',
  });
  // The sessions overlay re-reads the project directory on mount, so every
  // session has to exist on disk to survive to the capture.
  const sessions = [
    waitingSession,
    stoppedSession,
    seatDownSession,
    session,
    readySession,
    appliedSession,
    undoneSession,
    discardedSession,
  ];
  for (const item of sessions) {
    const dir = join(sessionsRoot(VISUAL_FIXTURE_PROJECT_DIR), item.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'summary.json'), JSON.stringify(item));
  }
  sessionsStore.__testReset({ sessions, totalCount: sessions.length });
}

/** The sessions of `seedSessions` with a newest open run whose task is written on several lines. */
function seedLongTaskSession(): Session {
  seedSessions();
  const session = makeSession({
    id: 'visual-session-long-task',
    feature:
      'Add generated JSON data fixtures, as one task:\n\n- Add `scripts/gen-json.js` (CommonJS) that writes them',
    startedAt: VISUAL_FIXTURE_EPOCH - 60_000,
    status: 'open',
    stop: 'stopped',
  });
  const sessions = [session, ...sessionsStore.get().sessions];
  sessionsStore.__testReset({ sessions, totalCount: sessions.length });
  return session;
}

function seedEditor(plan = makePlanProposal({ summary: 'Add greeting helper' })): void {
  const ownerToken = reviewStore.setReviewFile('fixtures/visual-session/plan.md', 8);
  editorStore.openRaw({
    filePath: 'fixtures/visual-session/plan.json',
    ownerToken,
    value: `${JSON.stringify(plan, null, 2)}\n`,
    layout: { columns: 72, rows: 19 },
  });
}

/** The edited plan names a criterion no task serves, so Ctrl+S keeps the editor open. */
function seedEditorUncoveredCriterion(): void {
  seedEditor(
    makePlanProposal({
      summary: 'Add greeting helper',
      criteria: [
        { id: 'C1', text: 'A name gets a greeting', checkIds: ['K1'] },
        { id: 'C2', text: 'An empty name is refused', checkIds: ['K1'] },
      ],
    }),
  );
}

function seedConfig(overrides?: VisualConfigOverrides): OverlaySeed {
  return () => seedVisualConfig(overrides);
}

function activateFallbackSeat(id: CrewSeatId): void {
  const config = configStore.get().config;
  if (config === null) throw new Error('Visual overlay fixture requires project config');
  const row = deriveFallbackRows({
    config,
    cliTools: detectionStore.get().cliTools,
    seatDisplayName: (runner, role) => resolveSeatDisplayName(runner, role, modelCacheStore),
  }).find((row) => row.id === id);
  if (row === undefined) throw new Error(`Visual overlay fixture requires a ${id} seat`);
  fallbackActivate({ row, config });
}

/** OpenCode detected ready, with every route its own listing serves and nothing else. */
function seedOpencodeReady(): void {
  // OpenCode's routes are one fact: its own listing. The probe reads it, so the
  // window, ladder and name of each row come with it and no second list can drift.
  publishVisualDiscovery({
    cliTools: [cliDetectionFor('ready', 'opencode')],
    cliModels: [
      catalogAttempt({
        tool: 'opencode',
        outcome: { kind: 'success', value: opencodeApiModels() },
      }),
    ],
  });
}

function seedOpencodeCatalog(): void {
  seedConfig({ planner: { kind: 'cli', tool: 'opencode', model: OPENCODE_ROUTED_MODEL } })();
  seedOpencodeReady();
}

function seedProviderAuth(
  arm: 'read' | 'unreadable',
  reason: CliProviderAuthUnreadableReason = 'parse-failure',
): void {
  seedOpencodeCatalog();
  const providerAuth: CliProviderAuth =
    arm === 'read'
      ? { kind: 'read', facts: [{ provider: 'OpenAI', source: 'api' }] }
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
 * OpenCode right after signing out of every provider: its listing now serves its own gateway
 * only, so the routes the previous read served are kept one more read with nothing vouching
 * for them.
 */
function seedSignedOutOpencode(): void {
  seedOpencodeCatalog();
  publishVisualDiscovery({
    cliTools: [cliDetectionFor('ready', 'opencode', { providerAuth: { kind: 'empty' } })],
    cliModels: [
      catalogAttempt({
        tool: 'opencode',
        outcome: {
          kind: 'success',
          value: opencodeApiModels().filter((model) => model.id.startsWith('opencode/')),
        },
      }),
    ],
  });
}

/**
 * OpenCode signed in to OpenAI only, on a seat route of another provider, with its model listing
 * not read: the credential listing cannot vouch for the route and no model list says otherwise.
 */
function seedOpencodeModelListUnread(): void {
  seedConfig({ planner: { kind: 'cli', tool: 'opencode', model: OPENCODE_UNLISTED_ROUTE } })();
  publishVisualDiscovery({
    cliTools: [
      cliDetectionFor('ready', 'opencode', {
        providerAuth: { kind: 'read', facts: [{ provider: 'OpenAI', source: 'api' }] },
      }),
    ],
    cliModels: [
      catalogAttempt({
        tool: 'opencode',
        outcome: { kind: 'command-failed', cause: 'opencode api GET /api/model exited 1' },
      }),
    ],
  });
}

const OPENCODE_UNLISTED_ROUTE = 'ollama-cloud/glm-5';

/**
 * OpenCode with Ollama Cloud set up only in its own config: `opencode auth list` prints no
 * credential, and its model listing serves its own gateway and that provider.
 */
function seedConfigOnlyOpencode(): void {
  seedConfig({ planner: { kind: 'cli', tool: 'opencode', model: OPENCODE_CONFIG_ROUTE } })();
  publishVisualDiscovery({
    cliTools: [cliDetectionFor('unauthenticated', 'opencode', { providerAuth: { kind: 'empty' } })],
    cliModels: [
      catalogAttempt({
        tool: 'opencode',
        outcome: {
          kind: 'success',
          value: opencodeConfigOnlyModels(),
        },
      }),
    ],
  });
}

const OPENCODE_CONFIG_ROUTE = 'ollama-cloud/glm-5.3';

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
    cliTools: [cliDetectionFor('ready', 'copilot', { installedVersion: '1.0.83' })],
    cliModels: [catalogAttempt({ tool: 'copilot', outcome: { kind: 'success', value: models } })],
  });
}

function seedCommandCodeNativeListing(): void {
  seedConfig({
    planner: { kind: 'cli', tool: 'command-code', model: 'deepseek/deepseek-v4-flash' },
  })();
  publishVisualDiscovery({
    cliTools: [cliDetectionFor('ready', 'command-code', { installedVersion: '1.62.1' })],
    cliModels: [
      catalogAttempt({
        tool: 'command-code',
        outcome: { kind: 'success', value: commandCodeListModels() },
      }),
    ],
  });
}

function seedCodexNativeListing(): void {
  const models = codexDebugModels();
  seedConfig({ planner: { kind: 'cli', tool: 'codex', model: models[0]?.id ?? 'gpt-6-astra' } })();
  publishVisualDiscovery({
    cliTools: [cliDetectionFor('ready', 'codex', { installedVersion: '0.155.1' })],
    cliModels: [catalogAttempt({ tool: 'codex', outcome: { kind: 'success', value: models } })],
  });
}

function seedCatalogFallback(): void {
  seedConfig({
    planner: {
      kind: 'cli',
      tool: 'claude-code',
      model: 'opus',
      fallback: { tool: 'codex', model: 'gpt-6-luna' },
    },
    implementer: { kind: 'cli', tool: 'codex', model: 'gpt-6-luna' },
  })();
  publishVisualDiscovery({
    cliTools: [cliDetectionFor('ready', 'codex'), cliDetectionFor('ready', 'claude-code')],
    cliModels: [
      catalogAttempt({
        tool: 'codex',
        outcome: { kind: 'success', value: [{ id: 'gpt-6-luna', displayName: 'GPT-6-Luna' }] },
      }),
    ],
  });
}

// `agy models` lists one row per effort variant (`gemini-3.8-flash-high`); the picker merges the
// variants into one family row whose expanded child is the effort axis, so the render only tells
// the truth when it is fed the real listing.
function antigravityModels(): readonly DetectedModel[] {
  const stdout = readFileSync(join(import.meta.dirname, 'antigravity-models.txt'), 'utf8');
  const catalog = parseAntigravityModelCatalog(stdout);
  if (catalog === null) throw new Error('antigravity-models.txt did not parse');
  return nativeCliCatalogToDetectedModels(catalog);
}

function seedAntigravityNativeListing(level: 'low' | 'medium' | 'high' = 'medium'): void {
  seedConfig({
    planner: {
      kind: 'cli',
      tool: 'antigravity',
      model: `gemini-3.8-flash-${level}`,
    },
  })();
  publishVisualDiscovery({
    cliTools: [cliDetectionFor('ready', 'antigravity', { installedVersion: '1.3.5' })],
    cliModels: [
      catalogAttempt({
        tool: 'antigravity',
        outcome: { kind: 'success', value: [...antigravityModels()] },
      }),
    ],
  });
}

// `agy models` 1.4.0 signed out: a progress line, then the error that says how to sign in.
function seedAntigravitySignedOut(): void {
  publishVisualDiscovery({
    cliTools: [
      cliDetectionFor('unauthenticated', 'antigravity', {
        installedVersion: '1.4.0',
        authChannel: 'session',
      }),
    ],
    cliModels: [
      catalogAttempt({
        tool: 'antigravity',
        outcome: {
          kind: 'command-failed',
          cause:
            'Please sign in to view available models. Launch the CLI without arguments to sign in.',
        },
      }),
    ],
  });
}

/** A model Kilo serves through more than one provider, so its row merges them. */
const KILO_ROUTED_MODEL = 'github-copilot/gpt-5.5';

function seedKiloConfirmed(): void {
  seedConfig({ planner: { kind: 'cli', tool: 'kilo-code', model: KILO_ROUTED_MODEL } })();
  publishVisualDiscovery({
    cliTools: [cliDetectionFor('ready', 'kilo-code', { installedVersion: '7.0.49' })],
    cliModels: [
      catalogAttempt({
        tool: 'kilo-code',
        outcome: { kind: 'success', value: kiloVerboseModels() },
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
    cliTools: [cliDetectionFor('ready', 'kilo-code', { installedVersion: '7.0.49' })],
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

function seedOpencodeCommandFailed(): void {
  seedConfig({
    planner: { kind: 'cli', tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash' },
  })();
  publishVisualDiscovery({
    cliTools: [cliDetectionFor('ready', 'opencode', { installedVersion: '2.0.26' })],
    cliModels: [
      catalogAttempt({
        tool: 'opencode',
        outcome: {
          kind: 'command-failed',
          cause: 'Server at http://127.0.0.1:49374 did not provide a compatible V2 health response',
        },
      }),
    ],
  });
}

function seedOpencodeSignedOutProbeTimeout(): void {
  seedConfig({
    planner: { kind: 'cli', tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash' },
  })();
  publishVisualDiscovery({
    cliTools: [
      cliDetectionFor('unauthenticated', 'opencode', {
        installedVersion: '2.0.26',
        authChannel: 'provider-dependent',
      }),
    ],
    cliModels: [catalogAttempt({ tool: 'opencode', outcome: { kind: 'timeout' } })],
  });
}

function seedOpencodeCommandFailedStale(): void {
  const models = opencodeApiModels().filter((model) =>
    ['opencode-go/deepseek-v4.1-flash', 'opencode-go/glm-5.3', 'opencode-go/kimi-k2.6'].includes(
      model.id,
    ),
  );
  publishVisualDiscovery({
    cliTools: [cliDetectionFor('ready', 'opencode', { installedVersion: '2.0.26' })],
    cliModels: [catalogAttempt({ tool: 'opencode', outcome: { kind: 'success', value: models } })],
  });
  seedOpencodeCommandFailed();
}

/** The `(NO ZDR)` family the collapsed frame must show, and the family the expanded frame opens. */
const CURSOR_NO_ZDR_MODEL = 'claude-fable-5-high';
const CURSOR_FAMILY_MODEL = 'gpt-5.6-sol-high';
const CURSOR_FAMILY_DRAFT = 'gpt-5.6-sol-xhigh-fast';

function seedCursorConfirmed(persisted: string): void {
  seedConfig({ planner: { kind: 'cli', tool: 'cursor', model: persisted } })();
  publishVisualDiscovery({
    cliTools: [cliDetectionFor('ready', 'cursor', { installedVersion: '2026.09.18-9a7762b' })],
    cliModels: [
      catalogAttempt({
        tool: 'cursor',
        outcome: { kind: 'success', value: cursorListModels() },
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
}): FixtureLifecycle {
  const {
    overlay,
    seed = EMPTY_SEED,
    underlyingScreen = 'home',
    workflowRoute = overlayWorkflowRoute,
    focus,
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
// first token reset after setup marks that wipe; replay after every sub-store has reset.
function reseedAfterWorkflowReset(seed: OverlaySeed): () => void {
  const stop = tokensStore.subscribe(() => {
    stop();
    queueMicrotask(seed);
  });
  return stop;
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
/** A custom endpoint named after a CLI tool: the identity collision these fixtures render. */
const BUILD_API_TWIN_SEAT = {
  kind: 'api',
  provider: 'opencode',
  service: 'opencode',
  offering: 'payg',
  apiBase: 'https://my-endpoint.example/v1',
  apiKey: 'sk-inline',
  model: 'gpt-5',
} as const;
/** The fallback a seat declares in config: a seat that cannot work moves to it. */
const SEAT_FALLBACK = {
  tool: 'opencode',
  model: 'opencode-go/deepseek-v4.1-flash',
  variant: 'max',
} as const;
const CODEX_FALLBACK = { tool: 'codex', model: 'gpt-6-astra', effort: 'high' } as const;
const PLANNER_WITH_FALLBACK = {
  kind: 'cli',
  tool: 'claude-code',
  model: 'opus',
  fallback: CODEX_FALLBACK,
} as const;
const BUILD_CODEX_SEAT = { kind: 'cli', tool: 'codex', model: CODEX_FALLBACK.model } as const;
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
const createPaletteSessionTaskFixture: FixtureFactory = () => ({
  ...createOverlayFixture({
    overlay: 'command-palette',
    seed: () => {
      seedLongTaskSession();
    },
  }),
  afterMount: (write) => write('fixtures'),
});
const createSkillsFixture: FixtureFactory = () =>
  createOverlayFixture({ overlay: 'skills', seed: seedSkills });
const createSkillsEmptyFixture: FixtureFactory = () => createOverlayFixture({ overlay: 'skills' });
const createSettingsFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'settings',
    seed: seedConfig({ implementer: { ...visualConfig().implementer, fallback: SEAT_FALLBACK } }),
  });
const createSettingsCrewFullFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'settings',
    seed: seedConfig({
      planner: PLANNER_HIGH_EFFORT,
      implementer: { ...BUILD_ANTHROPIC_SEAT, fallback: SEAT_FALLBACK },
      reviewer: REVIEWER_SEAT,
      escalation: ESCALATION_SEAT,
    }),
    focus: 'seat:build',
  });
const createSettingsAntigravityLowFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'settings',
    seed: () => seedAntigravityNativeListing('low'),
    focus: 'seat:plan',
  });
const createSettingsFallbackNoneFixture: FixtureFactory = () =>
  createOverlayFixture({ overlay: 'settings', focus: 'fallback:build' });
const createSettingsFallbackCatalogFixture: FixtureFactory = () =>
  createOverlayFixture({ overlay: 'settings', seed: seedCatalogFallback, focus: 'fallback:plan' });
const createSettingsFallbackSetFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'settings',
    seed: () => {
      seedOpencodeReady();
      seedCodexNativeListing();
      seedConfig({
        planner: PLANNER_WITH_FALLBACK,
        implementer: {
          kind: 'cli',
          tool: 'opencode',
          model: SEAT_FALLBACK.model,
          fallback: { tool: 'kilo-code', model: KILO_ROUTED_MODEL, variant: 'high' },
        },
        reviewer: {
          ...REVIEWER_SEAT,
          fallback: {
            tool: REVIEWER_SEAT.tool,
            model: REVIEWER_SEAT.model,
            effort: 'high',
          },
        },
      })();
    },
    focus: 'fallback:plan',
  });
// A ready OpenCode signed in to OpenAI whose listing serves no Ollama Cloud model: the BUILD
// fallback on that route needs a sign-in, so its row carries the needs sign-in note.
const createSettingsFallbackNeedsSignInFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'settings',
    seed: () => {
      seedConfig({
        implementer: {
          ...BUILD_CODEX_SEAT,
          fallback: { tool: 'opencode', model: OPENCODE_UNLISTED_ROUTE },
        },
      })();
      publishVisualDiscovery({
        cliTools: [
          cliDetectionFor('ready', 'codex'),
          cliDetectionFor('ready', 'opencode', {
            providerAuth: { kind: 'read', facts: [{ provider: 'OpenAI', source: 'api' }] },
          }),
        ],
        cliModels: [
          catalogAttempt({
            tool: 'opencode',
            outcome: {
              kind: 'success',
              value: opencodeApiModels().filter((model) => !model.id.startsWith('ollama-cloud/')),
            },
          }),
        ],
      });
    },
    focus: 'fallback:build',
  });
const createSettingsFallbackFilteredFixture: FixtureFactory = () =>
  createOverlayFixture({ overlay: 'settings', focus: 'filter:fallback' });
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
/** The seat most configs hold: a Claude alias, labelled from the bundled table, at its top level. */
const createSettingsClaudeAliasFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'settings',
    seed: seedConfig({
      planner: { kind: 'cli', tool: 'claude-code', model: 'opus', effort: 'max' },
    }),
    focus: 'seat:plan',
  });
/** An API build seat that reuses a CLI tool's name: the row reads its own endpoint, not that CLI. */
const createSettingsCrewApiTwinFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'settings',
    seed: seedConfig({ planner: PLANNER_HIGH_EFFORT, implementer: BUILD_API_TWIN_SEAT }),
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
// The Workflow section scrolls off an unfiltered Settings below 120 columns, and its policy
// row (`Plan approval`) reads as a value only when it is unset — so one scenario holds that
// section on screen at every width.
const createSettingsFilterApprovalFixture: FixtureFactory = () =>
  createOverlayFixture({ overlay: 'settings', focus: 'filter:approval' });
const createSettingsFilterWorkflowFixture: FixtureFactory = () =>
  createOverlayFixture({ overlay: 'settings', focus: 'filter:workflow' });
const createSettingsEndChecksFixture: FixtureFactory = () =>
  createOverlayFixture({ overlay: 'settings', focus: 'validation.endChecks' });
const createSettingsEndChecksOffFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'settings',
    seed: seedConfig({ validation: { endChecks: false } }),
    focus: 'validation.endChecks',
  });
const createSettingsSavedFixture: FixtureFactory = () => ({
  ...createSettingsEndChecksOffFixture(),
  afterMount: () => {
    feedbackStore.setMessage(
      formatConfigSaveSuccess('End-of-run checks · off', { ignoreRuleAdded: false }),
    );
  },
});
// The picker closed on a saved route that needs a sign-in: Settings carries the save message and
// the note in doctor's words.
const createSettingsSavedRouteSignInFixture: FixtureFactory = () => ({
  ...createOverlayFixture({
    overlay: 'settings',
    seed: seedConfig({ planner: { kind: 'cli', tool: 'opencode', model: 'opencode/big-pickle' } }),
  }),
  afterMount: () => {
    feedbackStore.setMessage(
      [
        formatConfigSaveSuccess('PLAN · OpenCode CLI · Big Pickle · via opencode', {
          ignoreRuleAdded: false,
        }),
        formatNeedsSignInSaveFeedback({ tool: 'opencode', provider: 'opencode' }),
      ].join(SOFT_SEP),
    );
  },
});
const createSettingsApproveChecksAskFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'settings',
    seed: seedConfig({ validation: { approveChecks: 'ask' } }),
    focus: 'validation.approveChecks',
  });
const createSettingsIsolationCheckoutFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'settings',
    seed: seedConfig({ workflow: { isolation: 'none' } }),
    focus: 'workflow.isolation',
  });
const createPlannerPickerFixture: FixtureFactory = () =>
  createOverlayFixture({ overlay: 'planner-picker' });
const createPlannerPickerCatalogFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: seedOpencodeCatalog,
    focus: OPENCODE_FOCUS,
  });
const createOpencodeExpandedFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: () => {
      seedProviderAuth('read');
      pickerViewStore.expand(OPENCODE_ROUTED_MODEL, OPENCODE_ROUTED_MODEL);
    },
    focus: OPENCODE_FOCUS,
  });
/** One model through two accounts, OpenRouter (signed in) and DeepSeek: each route names its account. */
const OPENROUTER_ROUTE = 'openrouter/deepseek/deepseek-v4.1-flash';
const createOpencodeOpenRouterRouteFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: () => {
      seedConfig({ planner: { kind: 'cli', tool: 'opencode', model: OPENROUTER_ROUTE } })();
      publishVisualDiscovery({
        cliTools: [
          cliDetectionFor('ready', 'opencode', {
            providerAuth: {
              kind: 'read',
              facts: [{ id: 'openrouter', provider: 'OpenRouter', source: 'stored' }],
            },
          }),
        ],
        cliModels: [
          catalogAttempt({
            tool: 'opencode',
            outcome: {
              kind: 'success',
              value: [
                { id: OPENROUTER_ROUTE, displayName: 'DeepSeek V4.1 Flash 1017' },
                { id: 'deepseek/deepseek-v4.1-flash', displayName: 'DeepSeek V4.1 Flash' },
              ],
            },
          }),
        ],
      });
      pickerViewStore.expand(OPENROUTER_ROUTE, OPENROUTER_ROUTE);
    },
    focus: OPENCODE_FOCUS,
  });
const createOpencodeExpandedDraftedFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: () => {
      seedProviderAuth('read');
      pickerViewStore.expand(OPENCODE_ROUTED_MODEL, OPENCODE_ROUTED_MODEL, 'max');
    },
    focus: OPENCODE_FOCUS,
  });
const createProviderExpandedEmptyFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: () => {
      seedSignedOutOpencode();
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
const createRoutesModelListUnreadFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: () => {
      seedOpencodeModelListUnread();
      pickerViewStore.expand(OPENCODE_UNLISTED_ROUTE);
    },
    focus: OPENCODE_FOCUS,
  });
const createConfigOnlyToolFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: () => {
      seedConfigOnlyOpencode();
      pickerViewStore.expand(OPENCODE_CONFIG_ROUTE);
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
const createPlannerPickerFirstDiscoveryFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: () => {
      detectionStore.reset();
      detectionStore.beginRefresh({
        contexts: {
          readiness: 'picker-first-check',
          modelsDev: 'picker-first-models',
          cliModels: 'picker-first-cli',
        },
      });
    },
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
      const config = configStore.get().config;
      if (config === null) throw new Error('Visual overlay fixture requires project config');
      const plan = deriveCrewRows({ config }).find((row) => row.id === 'plan');
      if (plan === undefined) throw new Error('Visual overlay fixture requires a plan seat');
      // The Settings crew row's ⏎, so the frame is the picker that row opens.
      crewActivate({ target: { kind: 'crew', row: plan }, config });
    },
    // The token the hook reads for the seat-axis landing — NOT 'tool:claude-code'. The left column
    // still lands on claude-code through the configured item, and the cursor lands on the effort axis.
    focus: seatAxisFocus('plan'),
  });
// The cursor leaves Claude Code for the next tool and comes back: the row reads the seat's level again.
const createClaudeEffortReturnedFixture: FixtureFactory = () => ({
  ...createClaudeEffortSetFixture(),
  afterMount: async (write) => {
    // Every key waits for the frame it changed. Sending the four keys without a settle lets
    // the walk outrun the view: the archived 120x40 capture photographed the cursor on
    // `+ Add custom command…` instead of the returned effort row.
    for (const key of ['\x1b[D', '\x1b[B', '\x1b[A', '\x1b[C']) {
      await write.press(key);
    }
  },
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
const createPlannerPickerKiloRoutesFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: () => {
      seedKiloConfirmed();
      pickerViewStore.expand(KILO_ROUTED_MODEL, KILO_ROUTED_MODEL);
    },
    focus: 'tool:kilo-code',
  });
const createPlannerPickerMalformedFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: seedKiloMalformed,
    focus: 'tool:kilo-code',
  });
const createPlannerPickerCommandFailedFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: seedOpencodeCommandFailed,
    focus: OPENCODE_FOCUS,
  });
const createPlannerPickerSignedOutProbeTimeoutFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: seedOpencodeSignedOutProbeTimeout,
    focus: OPENCODE_FOCUS,
  });
const createPlannerPickerCommandFailedStaleFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: seedOpencodeCommandFailedStale,
    focus: OPENCODE_FOCUS,
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
// A custom row that holds the full id an alias resolves to: the two rows name one model two ways.
const createPlannerPickerClaudeCustomTwinFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: () => {
      seedClaudeAliasRows();
      seedConfig({
        planner: {
          kind: 'cli',
          tool: 'claude-code',
          model: 'claude-opus-5-5',
          customModels: ['claude-opus-5-5'],
        },
      })();
    },
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
const createPlannerPickerCodexFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: seedCodexNativeListing,
    focus: 'tool:codex',
  });
const createPlannerPickerAntigravityFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: () => {
      seedAntigravityNativeListing();
      pickerViewStore.expand('gemini-3.8-flash-medium', 'gemini-3.8-flash-medium', null);
    },
    focus: 'tool:antigravity',
  });
// No effort flag on a model id that spells one: the row states the level the id runs.
const createPlannerPickerAntigravityListedFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: () => {
      seedAntigravityNativeListing('high');
      pickerViewStore.expand('gemini-3.8-flash-high', 'gemini-3.8-flash-high', null);
    },
    focus: 'tool:antigravity',
  });
const createPlannerPickerAntigravitySignedOutFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: seedAntigravitySignedOut,
    focus: 'tool:antigravity',
  });
const createPlannerPickerAntigravityLowFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: () => {
      seedAntigravityNativeListing('low');
      pickerViewStore.expand('gemini-3.8-flash-low', 'gemini-3.8-flash-low', null);
    },
    focus: seatAxisFocus('plan'),
  });
// A filter that leaves one model on two routes beside its namesake, as OpenCode 2.0.26 listed
// them: each row keeps the family and the id that tells it apart.
const createOpencodeFilterFixture: FixtureFactory = () => ({
  ...createOverlayFixture({
    overlay: 'planner-picker',
    seed: () => {
      seedOpencodeCatalog();
      const namesake = {
        id: 'deepseek/deepseek-flash',
        displayName: 'DeepSeek V4.1 Flash',
        contextLength: 1_000_000,
      };
      publishVisualDiscovery({
        cliTools: [cliDetectionFor('ready', 'opencode')],
        cliModels: [
          catalogAttempt({
            tool: 'opencode',
            outcome: { kind: 'success', value: [namesake, ...opencodeApiModels()] },
          }),
        ],
      });
    },
    focus: OPENCODE_FOCUS,
  }),
  afterMount: async (write) => {
    for (const key of 'deepseek v4.1') await write.press(key);
  },
});
// A custom row has no display name: the filter finds it by the name the row shows, not its id.
const createCustomFilterFixture: FixtureFactory = () => ({
  ...createOverlayFixture({
    overlay: 'planner-picker',
    seed: () => {
      seedConfig({
        planner: {
          kind: 'cli',
          tool: 'opencode',
          model: OPENCODE_ROUTED_MODEL,
          customModels: ['anthropic/claude-haiku-4-5'],
        },
      })();
      seedOpencodeReady();
    },
    focus: OPENCODE_FOCUS,
  }),
  afterMount: async (write) => {
    for (const key of 'claude haiku') await write.press(key);
  },
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

// A tool that is not signed in takes neither → nor ⏎; the hint offers only the keys that act.
const createSignedOutToolFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: () => {
      publishVisualDiscovery({
        cliTools: [
          cliDetectionFor('ready', 'codex'),
          cliDetectionFor('unauthenticated', 'claude-code', { authChannel: 'session' }),
        ],
      });
    },
    focus: 'tool:claude-code',
  });

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

// The cursor opens on the expanded model row; one step down lands it on the auth row, whose
// byline is the frame's subject.
const createAuthConfigOwnedFixture: FixtureFactory = () => ({
  ...createOverlayFixture({
    overlay: 'planner-picker',
    focus: OPENCODE_FOCUS,
    seed: () => {
      seedProviderAuth('read');
      pickerViewStore.expand(OPENCODE_ROUTED_MODEL);
    },
  }),
  afterMount: (write) => write('\x1b[B'),
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
// The entry's examples are the highlighted tool's own ids: Claude Code's aliases name the ids
// they resolve to, and Kilo spells its ids `provider/model`.
const createCustomModelClaudeFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: () => {
      seedClaudeAliasRows();
      pickerViewStore.open({ kind: 'custom-model' });
    },
    focus: 'tool:claude-code',
  });
// A save the config refused, standing while the picker is still open: the overlay hides the
// composer that would carry it, so the picker's own byline has to.
const createSaveRefusedFixture: FixtureFactory = () => ({
  ...createOverlayFixture({
    overlay: 'planner-picker',
    seed: seedClaudeAliasRows,
    focus: 'tool:claude-code',
  }),
  afterMount: () => {
    const path = '.splitbrief/config.yaml';
    reportConfigSaveFailure({
      kind: 'failure',
      ok: false,
      error: configError.saveFailed(
        path,
        configError.validationFailed(path, [
          `Configuration errors in ${path}:`,
          "  planner.outputFormat: Configured outputFormat cannot replace the claude-code terminal contract; the backend's native parser and terminal protocol stay authoritative.",
        ]),
      ),
    });
  },
});
const createCustomModelKiloFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-picker',
    seed: () => {
      seedKiloConfirmed();
      pickerViewStore.open({ kind: 'custom-model' });
    },
    focus: 'tool:kilo-code',
  });
const createImplementerPickerFixture: FixtureFactory = () =>
  createOverlayFixture({ overlay: 'implementer-picker' });
// The build seat on Claude Code: the tools byline names the sandbox that seat runs under.
const createImplementerPickerClaudeFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'implementer-picker',
    seed: () => {
      seedClaudeAliasRows();
      seedConfig({ implementer: { kind: 'cli', tool: 'claude-code' } })();
    },
  });
// The build seat is a custom endpoint named `opencode`: no CLI row may claim it as current, or
// confirming the pre-selected row would silently change the seat's kind.
const createImplementerPickerApiTwinFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'implementer-picker',
    seed: () => {
      seedOpencodeReady();
      seedConfig({ implementer: BUILD_API_TWIN_SEAT })();
    },
    focus: 'tool:opencode',
  });
// What a quota halt opens when the operator takes its seat swap: the seat's own picker, preselected
// on the tool the halt offered. `pickSwappedSeat` opens this exact overlay and focus token. A halt
// only ever offers a tool its readiness pass found ready, so the preselected row is seeded ready —
// an `Unavailable` one could never have been offered.
const createSeatSwapPickerFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'implementer-picker',
    seed: seedOpencodeReady,
    focus: OPENCODE_FOCUS,
  });
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
const createFallbackPickerFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'implementer-fallback-picker',
    seed: seedConfig({ implementer: BUILD_CODEX_SEAT }),
  });
const createFallbackPickerCurrentFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-fallback-picker',
    seed: () => {
      seedCodexNativeListing();
      seedConfig({ planner: PLANNER_WITH_FALLBACK })();
      activateFallbackSeat('plan');
    },
    focus: seatAxisFocus('plan'),
  });
const createFallbackPickerCatalogFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'planner-fallback-picker',
    seed: () => {
      seedCatalogFallback();
      activateFallbackSeat('plan');
    },
    focus: seatAxisFocus('plan'),
  });
const createFallbackPickerVariantFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'implementer-fallback-picker',
    seed: () => {
      seedOpencodeReady();
      seedConfig({
        implementer: {
          ...BUILD_CODEX_SEAT,
          fallback: { tool: 'opencode', model: OPENCODE_ROUTED_MODEL, variant: 'high' },
        },
      })();
      activateFallbackSeat('build');
    },
    focus: seatAxisFocus('build'),
  });
const createFallbackPickerInheritedReviewFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'reviewer-fallback-picker',
    seed: () => {
      seedCodexNativeListing();
      seedConfig({ planner: PLANNER_WITH_FALLBACK })();
      activateFallbackSeat('review');
    },
    focus: seatAxisFocus('review'),
  });
const createFallbackPickerCustomModelFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'reviewer-fallback-picker',
    seed: () => {
      seedCodexNativeListing();
      seedConfig({ planner: PLANNER_WITH_FALLBACK })();
      pickerViewStore.open({ kind: 'custom-model' });
    },
    focus: 'tool:codex',
  });
const createFallbackPickerSameSeatFixture: FixtureFactory = () => ({
  ...createOverlayFixture({
    overlay: 'implementer-fallback-picker',
    seed: () => {
      seedCodexNativeListing();
      seedConfig({ implementer: BUILD_CODEX_SEAT })();
    },
    focus: 'tool:codex',
  }),
  afterMount: () => {
    const identity = formatSeatIdentity({
      seat: BUILD_CODEX_SEAT,
      displayName: resolveSeatDisplayName(BUILD_CODEX_SEAT, 'implementer', modelCacheStore),
    });
    feedbackStore.setError(`BUILD runs ${identity} now${SOFT_SEP}choose another tool or model`);
  },
});
const STOP_SHEET_TS = 1_783_958_400_000;
const STOP_SHEET_RUNNING = taskId('T002');
const STOP_SHEET_NEXT = taskId('T003');

// The sheet's pause row names the brief it would finish and the one it would not start, so the run
// underneath it has to have both.
function seedStopSheetPlan(): void {
  addEvent({
    type: 'workflow_started',
    ts: STOP_SHEET_TS - 1_000,
    phase: 'implementing',
    feature: 'Add the stop sheet',
  });
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
}

function seedStopSheet(): void {
  seedStopSheetPlan();
  addEvent({
    type: 'task_started',
    ts: STOP_SHEET_TS + 10,
    phase: 'implementing',
    taskId: taskId('T001'),
    title: 'Add the stop sheet rows',
    index: 0,
    total: 3,
    file: 'src/features/workflow/stop/options.ts',
    action: 'create',
  });
  addEvent({
    type: 'task_completed',
    ts: STOP_SHEET_TS + 5_010,
    phase: 'implementing',
    taskId: taskId('T001'),
    title: 'Add the stop sheet rows',
    method: 'local',
    retries: 0,
    duration: 5_000,
  });
  addEvent({
    type: 'task_started',
    ts: STOP_SHEET_TS + 5_100,
    phase: 'implementing',
    taskId: STOP_SHEET_RUNNING,
    title: 'Render the stop sheet',
    index: 1,
    total: 3,
    file: 'src/features/workflow/stop/sheet.tsx',
    action: 'create',
    tool: 'ollama',
    model: 'qwen2.5-coder:7b',
  });
}

const createStopSheetFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'stop-sheet',
    seed: seedStopSheet,
    underlyingScreen: 'workflow',
  });
const createParkedStopMenuFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'stop-sheet',
    underlyingScreen: 'workflow',
    seed: () => {
      seedStopSheet();
      stopStore.request('stop-now');
      stopStore.park('mid-brief', 'T002', null);
      markWorkflowPaused();
    },
  });
// The stop cut the first brief before it wrote a file, so the run has no changes to keep.
const createParkedFirstBriefStopMenuFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'stop-sheet',
    underlyingScreen: 'workflow',
    seed: () => {
      seedStopSheetPlan();
      addEvent({
        type: 'task_started',
        ts: STOP_SHEET_TS + 10,
        phase: 'implementing',
        taskId: taskId('T001'),
        title: 'Add the stop sheet rows',
        index: 0,
        total: 3,
        file: 'src/features/workflow/stop/options.ts',
        action: 'create',
      });
      stopStore.request('stop-now');
      stopStore.park('mid-brief', 'T001', null);
      markWorkflowPaused();
    },
  });
const createSessionsFixture: FixtureFactory = () =>
  createOverlayFixture({ overlay: 'sessions', seed: seedSessions });

/** Apply holds this process while the newest run, a long multi-line task, is picked: the pick is refused. */
const createSessionsRefusedApplyingFixture: FixtureFactory = () => {
  const apply = Promise.withResolvers<void>();
  const base = createOverlayFixture({
    overlay: 'sessions',
    seed: () => {
      const session = seedLongTaskSession();
      const dir = join(sessionsRoot(VISUAL_FIXTURE_PROJECT_DIR), session.id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'summary.json'), JSON.stringify(session));
    },
  });
  return {
    ...base,
    setup: async (context) => {
      await base.setup(context);
      void trackActiveApply(apply.promise);
    },
    teardown: async () => {
      apply.resolve();
      await base.teardown();
    },
    afterMount: (write) => write('\r'),
  };
};
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
        stop: { kind: 'stopped', on: { kind: 'paused', at: 'boundary' } },
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
  details: ['Pick a review seat with a larger context in /crew review, then choose Try again.'],
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
  availableActions: ['retry-same-worker', 'end-run'],
  recommendedAction: 'retry-same-worker',
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
        stop: { kind: 'waiting-for-you', on: { kind: 'halt', issue: USAGE_CONTEXT_HALT } },
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

const PLAN_GATE_FEATURE = 'Fix the capped validation record';
const PLAN_GATE_TASKS = [
  makeTask({
    id: 'T001',
    title: 'Record the initial result',
    suggestedFiles: ['src/validation/result.ts'],
  }),
  makeTask({
    id: 'T002',
    title: 'Apply the retry result',
    suggestedFiles: ['src/validation/retry.ts'],
  }),
  makeTask({
    id: 'T003',
    title: 'Show the final result',
    suggestedFiles: ['src/validation/display.ts'],
  }),
];
const OLD_PLAN_TASK = makeTask({
  id: 'T001',
  title: 'Write the old validation path',
  suggestedFiles: ['src/validation/old.ts'],
  status: 'done',
});
const OLD_PLAN_LEDGER = createEvidenceLedger({
  sessionId: '2026-09-25-plan-gate-stop',
  feature: PLAN_GATE_FEATURE,
  tasks: [OLD_PLAN_TASK],
  briefHash: hashTaskBrief([OLD_PLAN_TASK]),
});
const REWOUND_GATE_LEDGER: EvidenceLedger = {
  ...OLD_PLAN_LEDGER,
  tasks: OLD_PLAN_LEDGER.tasks.map((task) => ({
    ...task,
    status: 'done',
    method: 'local',
    changedFiles: ['src/validation/old.ts'],
    briefHash: hashTaskBrief([OLD_PLAN_TASK]),
  })),
};

/** An Apply that wrote one of two files and stopped: Restore or Re-run Apply settles it. */
const APPLY_PARTIAL_HALT: RecoveryIssue = {
  id: 'rec_visual_apply_partial',
  reason: 'apply-partial',
  phase: 'complete',
  status: 'awaiting-user',
  files: ['src/features/workflow/stop/sheet.tsx'],
  affectedTaskIds: [],
  message: 'Apply did not finish: wrote 1 of 2 files.',
  details: [
    'Wrote 1 of 2 files; src/features/workflow/stop/sheet.tsx failed: disk full',
    'Backup of the replaced files: .splitbrief/sessions/2026-10-17-apply-partial/apply/b1',
  ],
  facts: { backupId: 'b1', written: 1, total: 2 },
  availableActions: ['retry-same-worker', 'restore-backup'],
  recommendedAction: 'retry-same-worker',
  createdAt: '2026-10-17T00:00:00.000Z',
};

/** Every brief of the stop sheet plan passed, so the run reached Apply. */
function seedAppliedBriefs(): void {
  seedStopSheetPlan();
  const briefs = [
    {
      id: taskId('T001'),
      title: 'Add the stop sheet rows',
      file: 'src/features/workflow/stop/options.ts',
      action: 'create' as const,
    },
    {
      id: STOP_SHEET_RUNNING,
      title: 'Render the stop sheet',
      file: 'src/features/workflow/stop/sheet.tsx',
      action: 'create' as const,
    },
    {
      id: STOP_SHEET_NEXT,
      title: 'Route the stop overlay',
      file: 'src/app/router.tsx',
      action: 'modify' as const,
    },
  ];
  briefs.forEach((brief, index) => {
    const ts = STOP_SHEET_TS + 10 + index * 5_000;
    addEvent({
      type: 'task_started',
      ts,
      phase: 'implementing',
      taskId: brief.id,
      title: brief.title,
      index,
      total: briefs.length,
      file: brief.file,
      action: brief.action,
    });
    addEvent({
      type: 'task_completed',
      ts: ts + 4_000,
      phase: 'implementing',
      taskId: brief.id,
      title: brief.title,
      method: 'local',
      retries: 0,
      duration: 4_000,
    });
  });
}

/** The run reopened at rest on that halt; its saved state still records the unfinished Apply. */
function applyPartialRoute(): RouteData {
  const state = {
    ...createInitialState('Add the stop sheet', new Date(VISUAL_PUBLISHED_AT)),
    phase: 'complete' as const,
    reviewStatus: 'passed' as const,
    workspace: {
      kind: 'staged-copy' as const,
      path: `${VISUAL_FIXTURE_PROJECT_DIR}/.splitbrief/workspace`,
      base: { snapshotId: 'visual-base', head: null },
    },
    applying: { at: '2026-10-17T00:00:00.000Z', backupId: 'b1' },
    pendingRecovery: APPLY_PARTIAL_HALT,
  };
  return {
    screen: 'workflow',
    run: makeRunRecord({
      ref: { projectDir: VISUAL_FIXTURE_PROJECT_DIR, sessionId: '2026-10-17-apply-partial' },
      feature: 'Add the stop sheet',
      hydration: { kind: 'loaded', state },
      status: deriveRunStatus({ state, liveness: 'not-alive' }),
    }),
    execution: { kind: 'at-rest' },
  };
}

/**
 * A stop at the plan gate, where the product leaves it: the run loop has returned, the route carries
 * the record it re-read, and no brief has started. End run closes the same record.
 */
function planGateRoute(
  status: RunStatus,
  summary: Summary | null = null,
  options: { tasks?: Task[]; ledger?: EvidenceLedger } = {},
): () => RouteData {
  return () => ({
    screen: 'workflow',
    run: makeRunRecord({
      ref: { projectDir: VISUAL_FIXTURE_PROJECT_DIR, sessionId: '2026-09-25-plan-gate-stop' },
      feature: PLAN_GATE_FEATURE,
      hydration: {
        kind: 'loaded',
        state: {
          ...createInitialState(PLAN_GATE_FEATURE, new Date(VISUAL_PUBLISHED_AT)),
          phase: 'reviewing-plan',
          tasks: options.tasks ?? PLAN_GATE_TASKS,
          mode: 'standard',
          awaitingContinue: status.kind === 'open',
        },
      },
      status,
      summary,
      ledger: options.ledger ?? null,
    }),
    execution: { kind: 'at-rest' },
  });
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

/**
 * The same name spent twice: a custom API endpoint named `opencode` and the CLI tool of that
 * name. The billing rows must name the endpoint literally and the tool by its catalog name.
 */
const USAGE_API_TWIN_BREAKDOWN: CostBreakdown = {
  actualPlannerCost: 0.42,
  actualImplementerCost: 1.18,
  totalActualCost: 1.6,
  hasPricedUsage: true,
  hasUnpricedUsage: true,
  providerCosts: {
    'api:opencode': { inputTokens: 400_000, outputTokens: 20_000, cost: 1.18 },
  },
  requestEstimate: {
    amount: null,
    currency: 'USD',
    basis: 'catalog-estimate',
    completeness: 'partial',
    knownSubtotal: 1.18,
    reasons: ['unpriced-model'],
    items: [
      {
        callId: 'call-api-1',
        role: 'implementer',
        usageBoundary: 'single-request',
        amount: 1.18,
        knownSubtotal: 1.18,
        completeness: 'complete',
        reasons: [],
        billing: { posture: 'api-metered', basis: 'observed-invocation' },
        rates: {
          source: 'models-dev',
          provider: 'opencode',
          model: 'gpt-5',
          inputPer1M: 1.25,
          outputPer1M: 10,
          capturedAt: VISUAL_PUBLISHED_AT,
        },
      },
      {
        callId: 'call-cli-1',
        role: 'planner',
        usageBoundary: 'single-request',
        amount: null,
        knownSubtotal: 0,
        completeness: 'unavailable',
        reasons: ['unpriced-model'],
        billing: { posture: 'unknown', basis: 'unknown' },
      },
    ],
  },
  providerRunMetadata: {
    'api:opencode': {
      service: 'opencode',
      offering: 'payg',
      normalizedEndpoint: 'https://my-endpoint.example/v1',
      billing: 'api-metered',
      asOf: '',
      billingAttribution: {
        posture: 'api-metered',
        basis: 'observed-invocation',
        evidenceId: 'api.observed.api-key',
      },
    },
    'cli:opencode': {
      service: 'opencode',
      offering: 'coding-subscription',
      normalizedEndpoint: 'cli:opencode',
      billing: 'subscription-included',
      asOf: '',
      billingAttribution: { posture: 'unknown', basis: 'unknown' },
    },
  },
  offeringPresentations: {
    'api:opencode': { costLabel: '$1.18', billingLabel: 'api-metered' },
    'cli:opencode': { costLabel: 'subscription-included', billingLabel: 'subscription-included' },
  },
};

const createUsageDetailsApiTwinFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'usage-details',
    seed: () => {
      seedUsageCounters();
      seedVisualConfig({ ...USAGE_CREW, implementer: BUILD_API_TWIN_SEAT });
    },
    underlyingScreen: 'workflow',
    workflowRoute: usageRoute(USAGE_API_TWIN_BREAKDOWN),
  });
const createUsageContextFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'usage-details',
    seed: seedUsageContextCounters,
    underlyingScreen: 'workflow',
    workflowRoute: usageContextRoute,
  });
const createEditorFixture: FixtureFactory = () =>
  createOverlayFixture({
    overlay: 'editor',
    seed: () => seedEditor(),
    underlyingScreen: 'workflow',
  });
const createEditorNotSavedFixture: FixtureFactory = () => ({
  ...createOverlayFixture({
    overlay: 'editor',
    seed: seedEditorUncoveredCriterion,
    underlyingScreen: 'workflow',
  }),
  afterMount: (write) => write.press('\x13'),
});

export const overlayFixtureRegistry: FixtureRegistry = new Map([
  [scenarioId('overlay-help'), createHelpFixture],
  [scenarioId('overlay-command-palette'), createPaletteFixture],
  [scenarioId('overlay-command-palette-session-task'), createPaletteSessionTaskFixture],
  [scenarioId('overlay-skills'), createSkillsEmptyFixture],
  [scenarioId('overlay-skills-list'), createSkillsFixture],
  [scenarioId('overlay-settings'), createSettingsFixture],
  [
    scenarioId('overlay-settings-opencode-routes'),
    () =>
      createOverlayFixture({ overlay: 'settings', seed: seedRoutedCrew, focus: 'fallback:build' }),
  ],
  [scenarioId('overlay-settings-crew-full'), createSettingsCrewFullFixture],
  [scenarioId('overlay-settings-antigravity-low'), createSettingsAntigravityLowFixture],
  [scenarioId('overlay-settings-fallback-none'), createSettingsFallbackNoneFixture],
  [scenarioId('overlay-settings-fallback-catalog'), createSettingsFallbackCatalogFixture],
  [scenarioId('overlay-settings-fallback-set'), createSettingsFallbackSetFixture],
  [scenarioId('overlay-settings-fallback-needs-sign-in'), createSettingsFallbackNeedsSignInFixture],
  [scenarioId('overlay-settings-fallback-filtered'), createSettingsFallbackFilteredFixture],
  [scenarioId('overlay-settings-inherited-effort'), createSettingsInheritedEffortFixture],
  [scenarioId('overlay-settings-crew-kilo-copilot'), createSettingsCrewKiloCopilotFixture],
  [scenarioId('overlay-settings-claude-alias'), createSettingsClaudeAliasFixture],
  [scenarioId('overlay-settings-crew-api-twin'), createSettingsCrewApiTwinFixture],
  [scenarioId('overlay-settings-floor-full'), createSettingsFloorFullFixture],
  [scenarioId('overlay-settings-filtered'), createSettingsFilteredFixture],
  [scenarioId('overlay-settings-filter-plan'), createSettingsFilterPlanFixture],
  [scenarioId('overlay-settings-filter-approval'), createSettingsFilterApprovalFixture],
  [scenarioId('overlay-settings-filter-workflow'), createSettingsFilterWorkflowFixture],
  [scenarioId('overlay-settings-end-checks'), createSettingsEndChecksFixture],
  [scenarioId('overlay-settings-end-checks-off'), createSettingsEndChecksOffFixture],
  [scenarioId('overlay-settings-saved'), createSettingsSavedFixture],
  [scenarioId('overlay-settings-saved-route-sign-in'), createSettingsSavedRouteSignInFixture],
  [scenarioId('overlay-settings-approve-checks-ask'), createSettingsApproveChecksAskFixture],
  [scenarioId('overlay-settings-isolation-checkout'), createSettingsIsolationCheckoutFixture],
  [scenarioId('overlay-planner-picker'), createPlannerPickerFixture],
  [scenarioId('overlay-planner-picker-catalog'), createPlannerPickerCatalogFixture],
  [scenarioId('overlay-picker-opencode-expanded'), createOpencodeExpandedFixture],
  [scenarioId('overlay-picker-opencode-expanded-drafted'), createOpencodeExpandedDraftedFixture],
  [scenarioId('overlay-picker-openrouter-route'), createOpencodeOpenRouterRouteFixture],
  [scenarioId('overlay-picker-claude-effort'), createClaudeEffortFixture],
  [scenarioId('overlay-picker-claude-effort-set'), createClaudeEffortSetFixture],
  [scenarioId('overlay-picker-claude-effort-returned'), createClaudeEffortReturnedFixture],
  [scenarioId('overlay-picker-provider-expanded-empty'), createProviderExpandedEmptyFixture],
  [scenarioId('overlay-picker-routes-model-list-unread'), createRoutesModelListUnreadFixture],
  [scenarioId('overlay-picker-config-only-tool'), createConfigOnlyToolFixture],
  [
    scenarioId('overlay-picker-provider-expanded-unreadable'),
    createProviderExpandedUnreadableFixture,
  ],
  [scenarioId('overlay-picker-routes-unchecked'), createRoutesUncheckedFixture],
  [scenarioId('overlay-planner-picker-first-discovery'), createPlannerPickerFirstDiscoveryFixture],
  [scenarioId('overlay-planner-picker-cold'), createPlannerPickerColdFixture],
  [scenarioId('overlay-planner-picker-no-listing'), createPlannerPickerNoListingFixture],
  [scenarioId('overlay-planner-picker-kilo'), createPlannerPickerKiloFixture],
  [scenarioId('overlay-planner-picker-kilo-free'), createPlannerPickerKiloFreeFixture],
  [scenarioId('overlay-planner-picker-kilo-routes'), createPlannerPickerKiloRoutesFixture],
  [scenarioId('overlay-planner-picker-malformed'), createPlannerPickerMalformedFixture],
  [scenarioId('overlay-planner-picker-command-failed'), createPlannerPickerCommandFailedFixture],
  [
    scenarioId('overlay-planner-picker-command-failed-stale'),
    createPlannerPickerCommandFailedStaleFixture,
  ],
  [scenarioId('overlay-planner-picker-claude'), createPlannerPickerClaudeFixture],
  [
    scenarioId('overlay-planner-picker-claude-custom-twin'),
    createPlannerPickerClaudeCustomTwinFixture,
  ],
  [scenarioId('overlay-planner-picker-copilot'), createPlannerPickerCopilotFixture],
  [scenarioId('overlay-planner-picker-command-code'), createPlannerPickerCommandCodeFixture],
  [scenarioId('overlay-planner-picker-codex'), createPlannerPickerCodexFixture],
  [scenarioId('overlay-planner-picker-antigravity'), createPlannerPickerAntigravityFixture],
  [scenarioId('overlay-planner-picker-antigravity-low'), createPlannerPickerAntigravityLowFixture],
  [
    scenarioId('overlay-planner-picker-antigravity-signed-out'),
    createPlannerPickerAntigravitySignedOutFixture,
  ],
  [
    scenarioId('overlay-planner-picker-antigravity-listed'),
    createPlannerPickerAntigravityListedFixture,
  ],
  [scenarioId('overlay-picker-opencode-filter'), createOpencodeFilterFixture],
  [scenarioId('overlay-picker-custom-filter'), createCustomFilterFixture],
  [scenarioId('overlay-planner-picker-cursor'), createPlannerPickerCursorFixture],
  [scenarioId('overlay-picker-cursor-expanded'), createCursorExpandedFixture],
  [scenarioId('overlay-picker-custom-launcher'), createCustomCommandLauncherFixture],
  [scenarioId('overlay-picker-local-server'), createLocalServerFixture],
  [scenarioId('overlay-picker-signed-out-tool'), createSignedOutToolFixture],
  [
    scenarioId('overlay-picker-signed-out-probe-timeout'),
    createPlannerPickerSignedOutProbeTimeoutFixture,
  ],
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
  [scenarioId('overlay-picker-custom-model-claude'), createCustomModelClaudeFixture],
  [scenarioId('overlay-picker-custom-model-kilo'), createCustomModelKiloFixture],
  [scenarioId('overlay-picker-save-refused'), createSaveRefusedFixture],
  [scenarioId('overlay-implementer-picker'), createImplementerPickerFixture],
  [scenarioId('overlay-implementer-picker-claude'), createImplementerPickerClaudeFixture],
  [scenarioId('overlay-implementer-picker-api-twin'), createImplementerPickerApiTwinFixture],
  [scenarioId('overlay-picker-seat-swap'), createSeatSwapPickerFixture],
  [scenarioId('overlay-picker-browse-escape'), createPickerBrowseEscapeFixture],
  [scenarioId('overlay-reviewer-picker-inherited'), createReviewerPickerFixture],
  [scenarioId('overlay-reviewer-picker-tool'), createReviewerPickerToolFixture],
  [scenarioId('overlay-fallback-picker'), createFallbackPickerFixture],
  [scenarioId('overlay-fallback-picker-current'), createFallbackPickerCurrentFixture],
  [scenarioId('overlay-fallback-picker-catalog'), createFallbackPickerCatalogFixture],
  [scenarioId('overlay-fallback-picker-variant'), createFallbackPickerVariantFixture],
  [
    scenarioId('overlay-fallback-picker-inherited-review'),
    createFallbackPickerInheritedReviewFixture,
  ],
  [scenarioId('overlay-fallback-picker-custom-model'), createFallbackPickerCustomModelFixture],
  [scenarioId('overlay-fallback-picker-same-seat'), createFallbackPickerSameSeatFixture],
  [scenarioId('workflow-stop-sheet'), createStopSheetFixture],
  [scenarioId('workflow-stop-menu-parked'), createParkedStopMenuFixture],
  [scenarioId('workflow-stop-menu-parked-first-brief'), createParkedFirstBriefStopMenuFixture],
  [
    scenarioId('workflow-stop-menu-quit-hint'),
    () => ({ ...createParkedStopMenuFixture(), afterMount: (write) => write('\x03') }),
  ],
  [
    scenarioId('workflow-stop-menu-failed'),
    () =>
      createOverlayFixture({
        overlay: 'stop-sheet',
        underlyingScreen: 'workflow',
        seed: () => {
          seedStopSheet();
          stopStore.request('stop-now');
          stopStore.fail('Could not save session: disk full');
        },
      }),
  ],
  [
    scenarioId('workflow-quit-hint'),
    () => {
      const base = createOverlayFixture({
        overlay: 'none',
        underlyingScreen: 'workflow',
        seed: () => {
          seedStopSheet();
          stopStore.request('stop-now');
          stopStore.park('mid-brief', 'T002', null);
          markWorkflowPaused();
        },
      });
      // The app's mount effects and the workflow's store reset both clear a quit hint seeded
      // before mount, and the keys effect that clears it runs in the same commit as the reset —
      // so the confirmation is armed one macrotask after the run settles into its parked state,
      // past every mount effect, where nothing clears it until teardown.
      let disarm: (() => void) | undefined;
      return {
        ...base,
        setup: async (context) => {
          await base.setup(context);
          let armed = false;
          const stop = stopStore.subscribe(() => {
            if (armed || stopStore.get().phase !== 'parked') return;
            armed = true;
            stop();
            setImmediate(() => feedbackStore.setMessage('Press ctrl+c again to quit'));
          });
          disarm = () => {
            armed = true;
            stop();
          };
        },
        teardown: () => {
          disarm?.();
          disarm = undefined;
          return base.teardown();
        },
      };
    },
  ],
  [
    scenarioId('workflow-stop-menu-pause'),
    () => ({ ...createStopSheetFixture(), afterMount: (write) => write('\x1b[B') }),
  ],
  [
    scenarioId('workflow-stop-sheet-fix-inserted'),
    () => ({
      ...createOverlayFixture({
        overlay: 'stop-sheet',
        underlyingScreen: 'workflow',
        seed: () => {
          addEvent({
            type: 'workflow_started',
            ts: STOP_SHEET_TS - 1_000,
            phase: 'implementing',
            feature: 'Add overdue book reporting',
          });
          for (const event of makeReviewFixInsertedEvents()) addEvent(event);
        },
      }),
      afterMount: (write) => write('\x1b[B'),
    }),
  ],
  [
    scenarioId('workflow-stop-sheet-after-continue'),
    // Continuing a halt resets its brief to pending before the build starts it again. The reset
    // lands once, after the screen's own store reset has run to its end, so the run stays in the
    // build.
    () => {
      let reset: NodeJS.Immediate | undefined;
      return createOverlayFixture({
        overlay: 'stop-sheet',
        underlyingScreen: 'workflow',
        seed: () => {
          seedStopSheet();
          clearImmediate(reset);
          reset = setImmediate(() =>
            addEvent({
              type: 'task_reset',
              ts: STOP_SHEET_TS + 5_200,
              phase: 'implementing',
              taskId: STOP_SHEET_RUNNING,
            }),
          );
        },
      });
    },
  ],
  [
    scenarioId('workflow-stop-menu-parked-gate'),
    () => ({
      ...createOverlayFixture({
        overlay: 'stop-sheet',
        underlyingScreen: 'workflow',
        workflowRoute: planGateRoute({
          kind: 'open',
          stop: { kind: 'stopped', on: { kind: 'paused', at: 'mid-step' } },
          resumeAt: { kind: 'gate', gate: 'plan' },
        }),
        seed: () => {
          stopStore.request('stop-now');
          stopStore.park('mid-brief', null, null);
          markWorkflowPaused();
        },
      }),
      afterMount: (write) => write('\x1b[B'),
    }),
  ],
  [
    scenarioId('workflow-stop-menu-parked-applying'),
    () =>
      createOverlayFixture({
        overlay: 'stop-sheet',
        underlyingScreen: 'workflow',
        workflowRoute: applyPartialRoute,
        seed: seedAppliedBriefs,
      }),
  ],
  [
    scenarioId('workflow-stop-menu-ended-gate'),
    () =>
      createOverlayFixture({
        overlay: 'stop-sheet',
        underlyingScreen: 'workflow',
        workflowRoute: planGateRoute(
          { kind: 'closed', as: 'ended' },
          makeSummary({
            feature: PLAN_GATE_FEATURE,
            phase: 'reviewing-plan',
            totalTasks: 3,
            completedByLocal: 0,
            plannerTool: 'claude-code',
            plannerModel: 'claude-sonnet-4',
            implementerTool: 'ollama',
            implementerModel: 'qwen2.5-coder:7b',
            mode: 'standard',
          }),
        ),
        seed: () => {
          stopStore.request('end-run');
          stopStore.end();
        },
      }),
  ],
  [
    scenarioId('workflow-stop-menu-ended-rewound-gate'),
    () =>
      createOverlayFixture({
        overlay: 'stop-sheet',
        underlyingScreen: 'workflow',
        workflowRoute: planGateRoute(
          { kind: 'closed', as: 'ended' },
          makeSummary({
            feature: PLAN_GATE_FEATURE,
            phase: 'reviewing-plan',
            totalTasks: 1,
            completedByLocal: 0,
            changedFiles: ['src/validation/old.ts'],
            stoppedAt: { taskId: OLD_PLAN_TASK.id, partialFiles: ['src/validation/old.ts'] },
            taskBreakdown: [
              {
                taskId: OLD_PLAN_TASK.id,
                taskTitle: OLD_PLAN_TASK.title,
                method: 'local',
                implementerTokens: 100,
                escalationTokens: 0,
                retryCount: 0,
              },
            ],
            mode: 'standard',
          }),
          { tasks: PLAN_GATE_TASKS.slice(0, 1), ledger: REWOUND_GATE_LEDGER },
        ),
        seed: () => {
          stopStore.request('end-run');
          stopStore.end();
        },
      }),
  ],
  [
    scenarioId('workflow-stop-sheet-planning'),
    // No brief has run, so the sheet has no changes to promise.
    () => createOverlayFixture({ overlay: 'stop-sheet', underlyingScreen: 'workflow' }),
  ],
  [scenarioId('overlay-sessions'), createSessionsFixture],
  [scenarioId('overlay-sessions-refused-applying'), createSessionsRefusedApplyingFixture],
  [scenarioId('overlay-usage-details'), createUsageDetailsFixture],
  [scenarioId('overlay-usage-details-legacy'), createUsageDetailsLegacyFixture],
  [scenarioId('overlay-usage-details-api-twin'), createUsageDetailsApiTwinFixture],
  [scenarioId('overlay-usage-context-insufficient'), createUsageContextFixture],
  [scenarioId('overlay-editor'), createEditorFixture],
  [scenarioId('overlay-editor-not-saved'), createEditorNotSavedFixture],
]);
