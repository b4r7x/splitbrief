import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { modelCacheStore } from '../../../src/stores/discovery/model-cache/state.js';
import type { RouteData } from '../../../src/stores/navigation/router.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { configStore } from '../../../src/stores/project/config.js';
import { resolveEffectiveConfig } from '../../../src/core/config/runtime/effective-config.js';
import { formatConfigLoaderDiagnostic, writeConfig } from '../../../src/core/config/load/io.js';
import { configPath, readConfigDocument } from '../../../src/core/config/load/document.js';
import type { CLIOverrides } from '../../../src/core/config/runtime/overrides/schema.js';
import { createProductionDetectionDeps } from '../../../src/engine/detection/deps.js';
import { detectionStore } from '../../../src/stores/project/detection.js';
import { skillsStore } from '../../../src/stores/project/skills.js';
import { composerDraftStore } from '../../../src/stores/ui/composer-draft.js';
import { feedbackStore } from '../../../src/stores/ui/feedback.js';
import {
  __testDiscardPending,
  flushSessionDrafts,
  nameDraftsNotRemoved,
  reportDraftNotSaved,
  saveSessionDraft,
} from '../../../src/stores/ui/session-drafts.js';
import { writeSessionDraft } from '../../../src/core/sessions/draft.js';
import { createDraftDocument } from '../../../src/core/composer/document.js';
import { LOCKFILE, sessionDir } from '../../../src/core/paths.js';
import { sessionError, sessionFileFailure } from '../../../src/core/sessions/errors.js';
import { sessionRelativePath } from '../../../src/core/sessions/ownership-marker.js';
import { formatAttachmentFailure } from '../../../src/core/attachments/failure.js';
import { SOFT_SEP } from '../../../src/core/separators.js';
import { formatNeedsSignInSaveFeedback } from '../../../src/features/runners/picker-format.js';
import { formatConfigSaveSuccess } from '../../../src/stores/project/save-feedback.js';
import type { InputFileFailureReason } from '../../../src/core/attachments/resolve.js';
import {
  CHECKING_TOOLS_STAGE,
  preparationStore,
} from '../../../src/stores/navigation/preparation.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import { resetWorkflow } from '../../../src/stores/workflow/actions/reset.js';
import type { ReadinessCheck, ReadinessReport } from '../../../src/core/readiness/types.js';
import { buildIsolationChecks } from '../../../src/core/readiness/checks/isolation.js';
import { buildRepoChecks } from '../../../src/core/readiness/checks/repo.js';
import { selectNextAction } from '../../../src/core/readiness/status.js';
import { formatSeatIdentity } from '../../../src/core/crew/identity.js';
import type { PreparationOutcome } from '../../../src/engine/runners/prepared-execution.js';
import {
  REPO_LOCAL_RUNNER_FIX,
  REPO_LOCAL_RUNNER_REFUSAL,
} from '../../../src/engine/runners/prepare-execution/evaluate-candidate.js';
import { blockedCheck } from '../../../src/engine/runners/prepare-execution/runner-candidates.js';
import { formatCustomRunnerDisclosure } from '../../../src/engine/runners/custom-runner-disclosure.js';
import { openApprovalPrompt } from '../../../src/stores/approval-prompt/prompt.js';
import type { CliToolDetection, DetectedModel } from '../../../src/core/discovery/detection.js';
import {
  nativeCliCatalogToDetectedModels,
  parseOpenCodeNativeModelCatalog,
} from '../../../src/engine/providers/cli-model-catalog.js';
import type { ClaudeCodeModelOption } from '../../../src/core/providers/claude-code-options.js';
import type { ScopedCliCatalogAttempt } from '../../../src/engine/detection/cli-catalog-outcomes.js';
import type { ModelsDevRefreshOutcome } from '../../../src/engine/detection/models-dev-lane.js';
import type { Config } from '../../../src/core/schemas/config.js';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import type { SkillMeta } from '../../../src/core/skills/types.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { listProjectFiles } from '../../../src/lib/file-listing.js';
import { saveState } from '../../../src/core/state/persistence.js';
import type { ModelsDevCatalog } from '../../../src/core/schemas/models-dev.js';
import { scenarioId } from '../contracts/identifiers.js';
import { makeConfig } from '../../helpers/factories/config.js';
import { cliDetectionFor } from '../../helpers/factories/detection.js';
import { createTestGitRepo } from '../../helpers/git.js';
import { makeRunRecord } from '../../helpers/factories/run-record.js';
import { resetAllStores } from '../../helpers/stores.js';
import { prepareWorkflowExecution } from '../../helpers/workflow-screen.js';
import {
  LONG_COMPOSER_DRAFT,
  type FixtureContext,
  type FixtureLifecycle,
  type FixtureRegistry,
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
  {
    id: 'claude-fable-5-1[1m]',
    displayName: 'Fable',
    description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks',
  },
];

const VISUAL_FIXTURE_WORK_DIR = `.test-artifacts/ui-fixture-worker-${process.pid}`;
export const VISUAL_FIXTURE_PROJECT_DIR = `${VISUAL_FIXTURE_WORK_DIR}/ui-fixture-project`;

type VisualConfigOverrides = Parameters<typeof makeConfig>[0];

export const VISUAL_WIDE_CREW: VisualConfigOverrides = {
  planner: { kind: 'cli', tool: 'codex', model: 'gpt-6-astra', effort: 'xhigh' },
  implementer: { kind: 'cli', tool: 'antigravity', model: 'gemini-3.8-flash-high' },
  reviewer: { kind: 'cli', tool: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
};

type VisualModelsDevArm = 'not-run' | 'pending' | 'failed' | { readonly catalog: ModelsDevCatalog };

export const BASE_PLANNER = {
  kind: 'cli',
  tool: 'claude-code',
  model: 'claude-sonnet-4',
} as const;

export const BASE_IMPLEMENTER = {
  kind: 'api',
  provider: 'ollama',
  service: 'ollama',
  offering: 'local',
  model: 'qwen2.5-coder:7b',
  apiBase: 'http://127.0.0.1:11434/v1',
  contextLength: 32_768,
  temperature: 0.2,
} as const;

/** The session every workflow fixture runs as. */
export const VISUAL_WORKFLOW_SESSION_ID = 'visual-workflow';

/** A seat override replaces the whole seat, so each seat override must be complete. */
export function visualConfig(overrides?: VisualConfigOverrides): Config {
  return makeConfig({
    planner: BASE_PLANNER,
    implementer: BASE_IMPLEMENTER,
    ...overrides,
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

// The whole of `opencode api GET /api/model` on opencode 2.0.14, the listing the probe reads, with
// `location.directory` neutralised. `api-model.json` beside it is the five-row parser fixture.
export function opencodeApiModels(): readonly DetectedModel[] {
  const stdout = readFileSync(
    join(import.meta.dirname, '../../fixtures/opencode/api-model-full.json'),
    'utf8',
  );
  const catalog = parseOpenCodeNativeModelCatalog(stdout);
  if (catalog === null) throw new Error('opencode/api-model-full.json did not parse');
  return nativeCliCatalogToDetectedModels(catalog);
}

/** The listing of an OpenCode with Ollama Cloud set up only in its config: its gateway and that provider. */
export function opencodeConfigOnlyModels(): readonly DetectedModel[] {
  return opencodeApiModels().filter(
    (model) => model.id.startsWith('opencode/') || model.id.startsWith('ollama-cloud/'),
  );
}

/**
 * Home, Settings and the seat picker read the config file again when it differs from the store, and
 * so does a running loop, so the fixture writes the file the store holds.
 */
export function seedVisualConfig(overrides?: VisualConfigOverrides): void {
  const config = visualConfig(overrides);
  configStore.__testReset({ config, diskConfig: config, projectDir: VISUAL_FIXTURE_PROJECT_DIR });
  persistVisualConfig();
}

export function persistVisualConfig(): void {
  const state = configStore.get();
  if (state.diskConfig === null) throw new Error('Visual run fixture requires project config');
  writeConfig(VISUAL_FIXTURE_PROJECT_DIR, state.diskConfig);
  configStore.__testReset({
    ...state,
    revision: readConfigDocument(VISUAL_FIXTURE_PROJECT_DIR).revision,
  });
}

/** Loads the fixture project as a project with no config file. */
function loadVisualProjectWithoutConfig(overrides?: CLIOverrides): void {
  rmSync(configPath(VISUAL_FIXTURE_PROJECT_DIR), { force: true });
  configStore.load(VISUAL_FIXTURE_PROJECT_DIR, overrides);
}

export function teardownVisualFixture(): void {
  resetVisualFixtureStores();
  removeFixtureProject();
}

function removeFixtureProject(): void {
  rmSync(VISUAL_FIXTURE_WORK_DIR, { recursive: true, force: true });
}

function createRouteFixture(
  route: () => RouteData,
  config?: VisualConfigOverrides,
): FixtureLifecycle {
  return {
    setup: (context) => {
      setupVisualFixture(context);
      if (config !== undefined) seedVisualConfig(config);
      routerStore.init(route());
    },
    teardown: teardownVisualFixture,
  };
}

interface HomeFixtureOptions {
  readonly config?: VisualConfigOverrides;
  readonly cold?: boolean;
  readonly detecting?: boolean;
  readonly checkFailed?: boolean;
  readonly noConfig?: boolean;
}

const HOME_FIXTURE_SKILLS = new Set(['brief-discipline', 'repo-conventions']);

export function createHomeFixture(options: HomeFixtureOptions = {}): FixtureLifecycle {
  return {
    setup: (context) => {
      setupVisualFixture(context);
      if (options.config !== undefined) seedVisualConfig(options.config);
      if (options.noConfig === true) loadVisualProjectWithoutConfig();
      skillsStore.setSelected(HOME_FIXTURE_SKILLS);
      if (options.cold !== true) publishFreshDiscovery();
      if (options.detecting === true) {
        detectionStore.beginRefresh({ contexts: VISUAL_DETECTION_CONTEXTS });
      }
      if (options.checkFailed === true) publishFailedColdCheck();
      routerStore.init({ screen: 'home' });
    },
    teardown: teardownVisualFixture,
  };
}

export function seedRoutedCrew(): void {
  seedVisualConfig({
    planner: { kind: 'cli', tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash' },
    implementer: {
      kind: 'cli',
      tool: 'opencode',
      model: 'ollama-cloud/deepseek-v4.1-flash',
      fallback: { tool: 'opencode', model: 'deepseek/deepseek-flash' },
    },
  });
  publishVisualDiscovery({
    cliTools: [cliDetectionFor('ready', 'opencode')],
    cliModels: [
      {
        connection: { tool: 'opencode', contextKey: 'planner-opencode-visual' },
        outcome: {
          kind: 'success',
          value: [
            'opencode-go/deepseek-v4.1-flash',
            'ollama-cloud/deepseek-v4.1-flash',
            'deepseek/deepseek-flash',
          ].map((id) => ({
            id,
            displayName: 'DeepSeek V4.1 Flash',
            maximumContextTokens: 1_000_000,
          })),
        },
      },
    ],
  });
}

/**
 * A resume state turns the fixture into the run the screen would actually
 * resume: the session is written to disk first, so the production resume path
 * hydrates it and whatever it carries — a halt, say — is driven by the real
 * code rather than staged by the fixture.
 */
export function createWorkflowBaseFixture(
  feature = 'Refine terminal navigation',
  resumeState?: WorkflowState | undefined,
  config?: VisualConfigOverrides,
): FixtureLifecycle {
  return createRouteFixture(() => {
    const config = configStore.get().config;
    if (config === null) throw new Error('Visual workflow fixture requires project config');
    const sessionId = VISUAL_WORKFLOW_SESSION_ID;
    persistVisualConfig();
    if (resumeState !== undefined) {
      saveState({ projectDir: VISUAL_FIXTURE_PROJECT_DIR, sessionId }, resumeState);
    }
    const prepared = prepareWorkflowExecution({
      projectDir: VISUAL_FIXTURE_PROJECT_DIR,
      feature,
      config,
      sessionId,
      ...(resumeState !== undefined && { resumeState }),
    });
    return {
      screen: 'workflow',
      run: makeRunRecord({
        ref: prepared.session.ref,
        feature,
      }),
      execution: { kind: 'local', prepared },
    };
  }, config);
}

function publishFreshDiscovery(): void {
  publishVisualDiscovery({
    cliTools: [cliDetectionFor('ready', 'claude-code'), cliDetectionFor('ready', 'codex')],
    modelsDev: { catalog: {} },
  });
}

// A first tool check that failed: it detected nothing, so it has no tools to merge.
function publishFailedColdCheck(): void {
  const request = detectionStore.beginRefresh({ contexts: VISUAL_DETECTION_CONTEXTS });
  detectionStore.publish({
    request,
    result: {
      providers: [],
      cliTools: [],
      catalog: null,
      cliModels: [],
      generation: 1,
      outcomes: {
        readiness: {
          kind: 'failed',
          source: 'readiness',
          contextKey: VISUAL_DETECTION_CONTEXTS.readiness,
          generation: 1,
          requestId: request.id,
          checkedAt: VISUAL_PUBLISHED_AT,
          error: { kind: 'timeout', message: 'Discovery request timed out.' },
        },
        modelsDev: {
          kind: 'not-run',
          source: 'models-dev',
          contextKey: VISUAL_DETECTION_CONTEXTS.modelsDev,
          reason: 'offline',
        },
        cliModels: {
          kind: 'not-run',
          source: 'cli-models',
          contextKey: VISUAL_DETECTION_CONTEXTS.cliModels,
          reason: 'offline',
        },
      },
    },
  });
}

/**
 * The one publisher of detected tools every visual fixture uses. Tools already detected
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

export function createSetupFixture(
  state:
    | 'initial'
    | 'saved'
    | 'saved-ignore-rule'
    | 'unavailable'
    | 'signed-out'
    | 'config-only'
    | 'detecting'
    | 'saved-detecting'
    | 'cached-refresh'
    | 'cached-failure'
    | 'api-override'
    | 'custom-api'
    | 'custom-unavailable'
    | 'persisted-api-override' = 'initial',
): FixtureLifecycle {
  let restoreFetch: (() => void) | undefined;
  return {
    setup: (context) => {
      setupVisualFixture(context);
      // Its own repository, so the first save is the one that adds the .splitbrief/ rule.
      if (state === 'saved-ignore-rule') {
        createTestGitRepo(VISUAL_FIXTURE_PROJECT_DIR, { '.gitignore': 'node_modules/\n' });
      }
      if (state !== 'unavailable' && state !== 'signed-out' && state !== 'config-only') {
        loadVisualProjectWithoutConfig();
      }
      if (state === 'saved-detecting') seedVisualConfig();
      if (state === 'config-only') {
        seedVisualConfig({
          implementer: { kind: 'cli', tool: 'opencode', model: 'ollama-cloud/glm-5.3' },
        });
      }
      if (state === 'custom-api' || state === 'custom-unavailable') {
        seedVisualConfig({
          implementer: {
            kind: 'api',
            provider: 'custom-api',
            service: 'custom-api',
            offering: 'payg',
            apiBase: 'https://custom.example.test/v1',
            apiKey: 'inline-test-key',
            model: 'custom-coder',
          },
        });
        const previousFetch = globalThis.fetch;
        globalThis.fetch = async (input, init) => {
          const url = String(input instanceof Request ? input.url : input);
          return url.startsWith('https://custom.example.test/')
            ? Response.json({
                data: [{ id: state === 'custom-api' ? 'custom-coder' : 'other-model' }],
              })
            : previousFetch(input, init);
        };
        restoreFetch = () => {
          globalThis.fetch = previousFetch;
        };
      }
      if (state === 'api-override' || state === 'persisted-api-override') {
        const overrides = {
          implementer: {
            model: 'custom-coder',
            apiBase: 'http://127.0.0.1:12434/v1',
          },
        };
        if (state === 'api-override') loadVisualProjectWithoutConfig(overrides);
        else {
          seedVisualConfig({ implementer: { model: 'custom-coder' } });
          const persisted = configStore.get().diskConfig;
          if (persisted === null) throw new Error('Expected a visual config');
          configStore.__testReset({
            ...configStore.get(),
            config: resolveEffectiveConfig({ base: persisted, overrides }).config,
            overrides,
          });
        }
      }
      if (state === 'cached-refresh' || state === 'cached-failure') {
        detectionStore.hydrate({
          cliTools: [cliDetectionFor('ready', 'claude-code'), cliDetectionFor('ready', 'opencode')],
          providers: [],
          fetchedAt: VISUAL_PUBLISHED_AT,
          validatedAt: VISUAL_PUBLISHED_AT,
          generation: 1,
          requestId: 1,
          contexts: VISUAL_DETECTION_CONTEXTS,
        });
        const request = detectionStore.beginRefresh({ contexts: VISUAL_DETECTION_CONTEXTS });
        if (state === 'cached-failure') {
          detectionStore.publishLane({
            request,
            lane: {
              lane: 'readiness',
              outcome: {
                kind: 'failed',
                source: 'readiness',
                contextKey: request.contexts.readiness,
                generation: 2,
                requestId: request.id,
                checkedAt: VISUAL_PUBLISHED_AT,
                error: { kind: 'request-failed', message: 'Tool discovery failed.' },
              },
            },
          });
        }
      } else if (state === 'detecting' || state === 'saved-detecting')
        detectionStore.beginRefresh({ contexts: VISUAL_DETECTION_CONTEXTS });
      // A new machine: three tools installed but not signed in, one ready.
      else if (state === 'signed-out')
        publishVisualDiscovery({
          cliTools: [
            cliDetectionFor('unauthenticated', 'claude-code'),
            cliDetectionFor('unauthenticated', 'codex'),
            cliDetectionFor('unauthenticated', 'antigravity'),
            cliDetectionFor('ready', 'opencode'),
          ],
          modelsDev: { catalog: {} },
        });
      // OpenCode stores no credential and calls Ollama Cloud, set up in its own config.
      else if (state === 'config-only')
        publishVisualDiscovery({
          cliTools: [
            cliDetectionFor('ready', 'claude-code'),
            cliDetectionFor('ready', 'codex'),
            cliDetectionFor('unauthenticated', 'opencode', { providerAuth: { kind: 'empty' } }),
          ],
          cliModels: [
            {
              connection: { tool: 'opencode', contextKey: 'implementer-opencode-visual' },
              outcome: {
                kind: 'success',
                value: opencodeConfigOnlyModels(),
              },
            },
          ],
          modelsDev: { catalog: {} },
        });
      // Every ready-made crew ready, so the checked seat is the one row that reads Unavailable.
      else if (state === 'custom-unavailable' || state === 'persisted-api-override')
        publishVisualDiscovery({
          cliTools: [
            cliDetectionFor('ready', 'claude-code'),
            cliDetectionFor('ready', 'codex'),
            cliDetectionFor('ready', 'opencode'),
          ],
          modelsDev: { catalog: {} },
        });
      else publishFreshDiscovery();
      if (state === 'api-override' || state === 'persisted-api-override') {
        const config = configStore.get().config;
        if (config === null) throw new Error('Expected a visual config');
        const { sourceContexts } = createProductionDetectionDeps({
          config,
          projectDir: VISUAL_FIXTURE_PROJECT_DIR,
        });
        detectionStore.setDetection({
          cliTools: detectionStore.get().cliTools,
          providers: [],
          providerOutcomes: sourceContexts.configuredProviders?.map((connection) => ({
            connection,
            state: 'fresh',
            catalog: 'populated',
            models: [{ id: 'custom-coder' }],
            fetchedAt: VISUAL_PUBLISHED_AT,
            validatedAt: VISUAL_PUBLISHED_AT,
          })),
        });
      }
      routerStore.init({ screen: 'setup', onComplete: 'home' });
    },
    // The user walks up from PLAN, past the two other ready-made crews, to the first one and
    // takes it; the cursor stays there.
    ...((state === 'saved' || state === 'saved-ignore-rule') && {
      afterMount: async (write) => {
        for (const key of ['\x1b[A', '\x1b[A', '\x1b[A', '\r']) await write.press(key);
      },
    }),
    teardown: () => {
      restoreFetch?.();
      teardownVisualFixture();
    },
  };
}

const SKILLS_COMPLETION_FIXTURE: SkillMeta[] = [
  {
    id: 'brief-discipline',
    name: 'Brief discipline',
    description:
      'Keep every Task Brief to one slice: the files it may touch, the gates it must pass, the evidence it leaves',
    path: 'fixtures/skills/brief-discipline/SKILL.md',
    scope: 'project',
    projectDir: VISUAL_FIXTURE_PROJECT_DIR,
  },
  {
    id: 'repo-conventions',
    name: 'Repo conventions',
    description:
      'House idiom for this repository: layering, file naming, import style and the rules a review will check',
    path: 'fixtures/skills/repo-conventions/SKILL.md',
    scope: 'project',
    projectDir: VISUAL_FIXTURE_PROJECT_DIR,
  },
  {
    id: 'splitbrief-add-feature',
    name: 'splitbrief-add-feature',
    description:
      'Plan a feature as a chain of briefs, one slice per brief, with gates and acceptance criteria spelled out',
    path: 'fixtures/skills/splitbrief-add-feature/SKILL.md',
    scope: 'project',
    projectDir: VISUAL_FIXTURE_PROJECT_DIR,
  },
  {
    id: 'splitbrief-implement-spec',
    name: 'splitbrief-implement-spec',
    description:
      'Execute an approved spec brief by brief, validating every slice against the project gates before hand-off',
    path: 'fixtures/skills/splitbrief-implement-spec/SKILL.md',
    scope: 'project',
    projectDir: VISUAL_FIXTURE_PROJECT_DIR,
  },
  {
    id: 'splitbrief-docs-sync',
    name: 'splitbrief-docs-sync',
    description:
      'Keep the documentation map honest: every link resolves and every claim matches what the source really does',
    path: 'fixtures/skills/splitbrief-docs-sync/SKILL.md',
    scope: 'project',
    projectDir: VISUAL_FIXTURE_PROJECT_DIR,
  },
  {
    id: 'agents-root',
    name: 'AGENTS.md',
    description: 'Root agent instructions',
    path: 'fixtures/skills/agents-root/SKILL.md',
    scope: 'project',
    projectDir: VISUAL_FIXTURE_PROJECT_DIR,
  },
  {
    id: '2d-games',
    name: '2d-games',
    description:
      '2D game development principles. Sprites, tilemaps, physics, camera, input and the game loop',
    path: 'fixtures/skills/2d-games/SKILL.md',
    scope: 'global',
  },
  {
    id: '3d-games',
    name: '3d-games',
    description:
      '3D game development principles. Scenes, meshes, materials, lighting, cameras and the render loop',
    path: 'fixtures/skills/3d-games/SKILL.md',
    scope: 'global',
  },
  {
    id: '3d-web-experience',
    name: '3d-web-experience',
    description:
      'Interactive 3D on the web: scene graphs, asset budgets, shaders and input that stays responsive',
    path: 'fixtures/skills/3d-web-experience/SKILL.md',
    scope: 'global',
  },
  {
    id: '8-bit-pixel-art-patterns',
    name: '8-bit-pixel-art-patterns',
    description:
      'Pixel art at 8-bit scale: palettes, dithering, sprite sheets, animation timing and readable silhouettes',
    path: 'fixtures/skills/8-bit-pixel-art-patterns/SKILL.md',
    scope: 'global',
  },
  {
    id: 'ai-agents-architect',
    name: 'ai-agents-architect',
    description:
      'Design agent systems: tool contracts, memory, delegation, evaluation harnesses and failure recovery',
    path: 'fixtures/skills/ai-agents-architect/SKILL.md',
    scope: 'global',
  },
  {
    id: 'api-security-best-practices',
    name: 'api-security-best-practices',
    description:
      'Secure an HTTP API: authentication, authorization, input validation, rate limits and audit trails',
    path: 'fixtures/skills/api-security-best-practices/SKILL.md',
    scope: 'global',
  },
  {
    id: 'frontend-design',
    name: 'frontend-design',
    description:
      'Distinctive, intentional visual design: typography, spacing, colour and motion that never read as defaults',
    path: 'fixtures/skills/frontend-design/SKILL.md',
    scope: 'global',
  },
  {
    id: 'web-performance-optimization',
    name: 'web-performance-optimization',
    description:
      'Make the web app fast: bundle budgets, rendering work, network waterfalls and measured regressions',
    path: 'fixtures/skills/web-performance-optimization/SKILL.md',
    scope: 'global',
  },
];

/**
 * The check a start or a continuation is waiting on, held open for the capture. It is submitted
 * through the coordinator every screen already submits to, so the frame shows the real wiring.
 */
function submitHeldCheck(origin: 'start' | 'continue'): void {
  preparationStore.submit({
    origin,
    stage: CHECKING_TOOLS_STAGE,
    prepare: () => new Promise(() => {}),
    onPrepared: () => {},
  });
}

/** A cold start: the CLI submitted the check before the mount, so Home has nothing to cancel. */
function createHomePreparingFixture(): FixtureLifecycle {
  const home = createHomeFixture();
  return {
    setup: async (context) => {
      await home.setup(context);
      submitHeldCheck('start');
    },
    teardown: home.teardown,
  };
}

/**
 * A check that has already answered, so the panel that needs answering is on screen. The checks are
 * built by the readiness builders themselves, so the copy in the capture is the copy an operator
 * really reads rather than a fixture's paraphrase of it.
 */
function submitSettledCheck(outcome: PreparationOutcome): void {
  preparationStore.submit({
    origin: 'continue',
    stage: CHECKING_TOOLS_STAGE,
    prepare: () => Promise.resolve(outcome),
    onPrepared: () => {},
  });
}

const TRUST_BOUNDARY_CHECK: ReadinessCheck = {
  id: 'runners.planner.trust-boundary',
  severity: 'warning',
  summary: `Planner ${formatSeatIdentity({ seat: BASE_PLANNER })} can execute commands on this machine.`,
  details: [
    'Plan approval: plan.',
    'Only a write to a protected path asks.',
    'SPLITBRIEF approval gates review the plan and declared/promoted file writes; they do not sandbox shell commands or network access inside external runners.',
  ],
};

function preparationReport(
  checks: readonly ReadinessCheck[],
  options: {
    readonly section?: { readonly id: string; readonly title: string } | undefined;
  } = {},
): ReadinessReport {
  const blocker = checks.filter((check) => check.severity === 'blocker').length;
  const warning = checks.filter((check) => check.severity === 'warning').length;
  const status = blocker > 0 ? 'blocked' : 'ready-with-warnings';
  const section = options.section ?? { id: 'runners', title: 'Runners' };
  return {
    generatedAt: '2026-08-04T00:00:00.000Z',
    projectDir: VISUAL_FIXTURE_PROJECT_DIR,
    status,
    counts: { ok: 4, info: 0, warning, blocker },
    nextAction: selectNextAction([...checks], status),
    sections: [{ id: section.id, title: section.title, checks: [...checks] }],
    metadata: {},
  };
}

/** The contradiction this panel exists to prevent: an execution error with no blocker at all. */
function createHomePreparationFailedFixture(): FixtureLifecycle {
  const home = createHomeFixture();
  return {
    setup: async (context) => {
      await home.setup(context);
      submitSettledCheck({
        kind: 'failed',
        report: preparationReport([TRUST_BOUNDARY_CHECK]),
        error: new Error(
          'Session ownership could not be taken over: 20260804-a91f is held by another SPLITBRIEF process.',
        ),
      });
    },
    teardown: home.teardown,
  };
}

function createHomePreparationCheckoutWarningFixture(): FixtureLifecycle {
  const home = createHomeFixture();
  return {
    setup: async (context) => {
      await home.setup(context);
      submitSettledCheck({
        kind: 'failed',
        report: preparationReport(
          buildRepoChecks(
            {
              isGitRepo: true,
              hasCommits: true,
              dirtyFiles: ['src/app.ts'],
              untrackedFiles: ['scratch.txt'],
            },
            'none',
          ),
          { section: { id: 'repo', title: 'Repository' } },
        ),
        error: new Error('Session ownership could not be taken over.'),
      });
    },
    teardown: home.teardown,
  };
}

function createHomePreparationBlockedFixture(): FixtureLifecycle {
  const home = createHomeFixture();
  return {
    setup: async (context) => {
      await home.setup(context);
      submitSettledCheck({
        kind: 'blocked',
        report: preparationReport([
          {
            id: 'runners.planner.available',
            severity: 'blocker',
            summary: 'Ollama is not reachable at http://localhost:11434/v1',
            details: ['Start Ollama with: ollama serve', 'Then retry this connection.'],
          },
        ]),
      });
    },
    teardown: home.teardown,
  };
}

/**
 * The trust panel a runner the project config declares opens on its first start. The disclosure is
 * the real formatter's output for a project `agent` command, so the panel shows the rows an
 * operator really reads.
 */
function openRunnerTrustPrompt(): void {
  const disclosure = formatCustomRunnerDisclosure({
    executable: '"tools/review-bot"',
    argv: ['"--diff"'],
    contract: 'direct',
    cwd: 'Project directory',
    stage: 'None',
    environment: ['"REVIEW_BOT_TOKEN"'],
    environmentAccess: 'Declared environment references only',
    filesystem: 'Not an OS sandbox; the process can access files available to the current user',
    network: 'Network access is not restricted',
    result: 'Reviewed workspace diff; it writes directly into the project directory',
  });
  void openApprovalPrompt({
    tier: 'confirm',
    actionClass: 'runner_trust',
    actionDescription: `${disclosure}\n\nExact confirmation stores an owner-only reusable receipt.`,
    phase: 'planning',
  });
}

/** The first start of a runner the project config declares: the check waits on the trust panel. */
function createHomePreparationRunnerTrustFixture(): FixtureLifecycle {
  const home = createHomeFixture();
  return {
    setup: async (context) => {
      await home.setup(context);
      submitHeldCheck('start');
      openRunnerTrustPrompt();
    },
    teardown: home.teardown,
  };
}

/**
 * The readiness blocker that recommends the checkout. The check comes from the real
 * `buildIsolationChecks` against a throwaway workspace manifest, so the panel shows the summary
 * and the fix line an operator really reads, and the report is filed in the `repo` section with
 * the `fix-config` next action `collect.ts` and `status.ts` produce.
 */
function createHomePreparationIsolationBlockedFixture(): FixtureLifecycle {
  const home = createHomeFixture();
  return {
    setup: async (context) => {
      await home.setup(context);
      const manifestDir = join(VISUAL_FIXTURE_WORK_DIR, 'isolation-workspace-manifest');
      mkdirSync(manifestDir, { recursive: true });
      writeFileSync(
        join(manifestDir, 'package.json'),
        JSON.stringify({
          name: 'isolation-workspace-fixture',
          private: true,
          workspaces: ['packages/*'],
        }),
      );
      const checks = buildIsolationChecks(manifestDir, undefined);
      rmSync(manifestDir, { recursive: true, force: true });
      submitSettledCheck({
        kind: 'blocked',
        report: preparationReport(checks, {
          section: { id: 'repo', title: 'Repository' },
        }),
      });
    },
    teardown: home.teardown,
  };
}

const CONTINUING_FEATURE = 'Refine terminal navigation';

function createWorkflowContinuingFixture(): FixtureLifecycle {
  const state = { ...createInitialState(CONTINUING_FEATURE), phase: 'implementing' as const };
  const workflow = createRouteFixture(() => ({
    screen: 'workflow',
    run: makeRunRecord({
      ref: { projectDir: VISUAL_FIXTURE_PROJECT_DIR, sessionId: 'visual-continuing' },
      feature: CONTINUING_FEATURE,
      hydration: { kind: 'loaded', state },
      status: {
        kind: 'open',
        stop: { kind: 'stopped', on: { kind: 'interrupted' } },
        resumeAt: { kind: 'planner', call: 'tasks' },
      },
    }),
    execution: { kind: 'at-rest' },
  }));
  return {
    setup: async (context) => {
      await workflow.setup(context);
      submitHeldCheck('continue');
      // The composer beside the status is live: a correction typed during the check is still there
      // when it lands.
      composerDraftStore.request('and keep the parser out of the brief header');
    },
    teardown: workflow.teardown,
  };
}

/** Continuing a run whose declared runner was never trusted: the check waits on the trust panel. */
function createWorkflowContinueRunnerTrustFixture(): FixtureLifecycle {
  const continuing = createWorkflowContinuingFixture();
  return {
    setup: async (context) => {
      await continuing.setup(context);
      openRunnerTrustPrompt();
    },
    teardown: continuing.teardown,
  };
}

/**
 * Continuing a run whose repo-local planner command needs the grant this process does not hold. The
 * check is the real preparation blocker, so the capture shows the fix line an operator reads.
 */
function createWorkflowContinueRepoRunnerBlockedFixture(): FixtureLifecycle {
  const state = { ...createInitialState(CONTINUING_FEATURE), phase: 'planning' as const };
  const workflow = createRouteFixture(() => ({
    screen: 'workflow',
    run: makeRunRecord({
      ref: { projectDir: VISUAL_FIXTURE_PROJECT_DIR, sessionId: 'visual-repo-runner-blocked' },
      feature: CONTINUING_FEATURE,
      hydration: { kind: 'loaded', state },
      status: {
        kind: 'open',
        stop: { kind: 'stopped', on: { kind: 'paused', at: 'boundary' } },
        resumeAt: { kind: 'planner', call: 'plan' },
      },
    }),
    execution: { kind: 'at-rest' },
  }));
  return {
    setup: async (context) => {
      await workflow.setup(context);
      submitSettledCheck({
        kind: 'blocked',
        report: preparationReport([
          blockedCheck(
            { role: 'planner' },
            'shell',
            REPO_LOCAL_RUNNER_REFUSAL.reason,
            REPO_LOCAL_RUNNER_FIX.resume,
          ),
        ]),
      });
    },
    teardown: workflow.teardown,
  };
}

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

// A retired command typed on a run's screen: the answer names what replaced it.
function createRemovedCommandFixture(): FixtureLifecycle {
  const workflow = createWorkflowBaseFixture();
  return {
    setup: async (context) => {
      await workflow.setup(context);
      composerDraftStore.request('/revise-plan split the brief');
    },
    teardown: workflow.teardown,
    afterMount: (write) => write('\r'),
  };
}

// The home fixture already selects two project skills, so the seeded catalog keeps them; the rest
// overflow the eight-row window the menu gets at these viewports.
function createSkillsCompletionFixture(): FixtureLifecycle {
  const home = createHomeFixture();
  return {
    setup: async (context) => {
      await home.setup(context);
      skillsStore.setAvailable(SKILLS_COMPLETION_FIXTURE);
      composerDraftStore.request('/skills ');
    },
    teardown: home.teardown,
  };
}

// The user takes /crew from the palette over a typed draft; `cleared` then deletes the filled-in
// command, and the draft comes back.
function createPalettePrefillFixture(cleared: boolean): FixtureLifecycle {
  const home = createHomeFixture();
  return {
    setup: async (context) => {
      await home.setup(context);
      composerDraftStore.request('keep the scanner screen as it is');
    },
    teardown: home.teardown,
    afterMount: async (write) => {
      for (const key of ['\x0b', 'crew', '\r']) await write.press(key);
      if (cleared) for (const _ of '/crew ') await write.press('\b');
    },
  };
}

function createDraftPathFixture(): FixtureLifecycle {
  const home = createHomeFixture();
  return {
    setup: async (context) => {
      await home.setup(context);
      composerDraftStore.request('/Users/dev/notes/brief.md plan from this brief');
    },
    teardown: home.teardown,
  };
}

function createLongDraftFixture(): FixtureLifecycle {
  const home = createHomeFixture();
  return {
    setup: async (context) => {
      await home.setup(context);
      composerDraftStore.request(LONG_COMPOSER_DRAFT);
    },
    teardown: home.teardown,
  };
}

const ATTACHMENT_FAILURE_DRAFTS: Record<InputFileFailureReason, { path: string; prompt: string }> =
  {
    'not-found': {
      path: '/Users/me/notes/product-planning/archive/receiving-workflow/brief.md',
      prompt: 'use this brief',
    },
    'not-a-file': { path: '/Users/me/notes/product-planning/archive/', prompt: 'use this folder' },
    'too-large': { path: '/Users/me/exports/receiving-dump.log', prompt: 'summarize this' },
    unreadable: {
      path: '/Users/me/notes/product-planning/archive/receiving-workflow/brief.md',
      prompt: 'use this brief',
    },
    'not-text': { path: '/Users/me/exports/archive.zip', prompt: 'read this archive' },
  };

function attachmentFailureMessage(reason: InputFileFailureReason): string {
  return formatAttachmentFailure({
    action: 'send',
    reason,
    path: ATTACHMENT_FAILURE_DRAFTS[reason].path,
  });
}

function createOutsideAttachmentFailureFixture(reason: InputFileFailureReason): FixtureLifecycle {
  const home = createHomeFixture();
  return {
    setup: async (context) => {
      await home.setup(context);
      const { path, prompt } = ATTACHMENT_FAILURE_DRAFTS[reason];
      composerDraftStore.request(`@${path} ${prompt}`);
      feedbackStore.setError(attachmentFailureMessage(reason));
    },
    teardown: home.teardown,
  };
}

const SAVE_SIGN_IN_CONFIG = {
  implementer: { kind: 'cli', tool: 'opencode', model: 'anthropic/claude-haiku-4-5' },
} as const;

// The message the BUILD picker saves for a custom model on a provider with no credential.
const SAVE_SIGN_IN_MESSAGE = [
  formatConfigSaveSuccess('BUILD · OpenCode CLI · Claude Haiku 4.5 · via anthropic', {
    ignoreRuleAdded: false,
  }),
  formatNeedsSignInSaveFeedback({ tool: 'opencode', provider: 'anthropic' }),
].join(SOFT_SEP);

// The line the screen shows for two retired config keys raised before it opened.
const STARTUP_WARNINGS_MESSAGE =
  '2 warnings, all shown when you quit · ⚠ workflow.mode was retired and is ignored: every run plans in one session. Delete workflow.mode.';

// The line the screen shows for a config file its group or other users can change, the one warning raised.
const STARTUP_PERMISSION_WARNING_MESSAGE = `⚠ ${formatConfigLoaderDiagnostic({ kind: 'config-file-permissions' })}`;

function withStartupWarnings(
  fixture: FixtureLifecycle,
  message: string = STARTUP_WARNINGS_MESSAGE,
): FixtureLifecycle {
  return {
    ...fixture,
    setup: async (context) => {
      await fixture.setup(context);
      feedbackStore.setError(message);
    },
  };
}

/** A session id of the length most real ones have, so the file names a path that has to wrap. */
export const LONG_SESSION_ID = '2026-10-22-add-a-greeting-helper-to-the-cli-entry-point-docs';

export const UNSAVED_DRAFT_ERROR = sessionError.draftNotSaved(
  sessionRelativePath(LONG_SESSION_ID, 'draft.json'),
  Object.assign(new Error("EACCES: permission denied, open '/x/draft.json'"), { code: 'EACCES' }),
);

// The line a run that cannot release its lock leaves on the feedback row.
export const RUN_LOCK_NOT_RELEASED = `${sessionFileFailure(
  'Could not release the run lock',
  sessionRelativePath(LONG_SESSION_ID, LOCKFILE),
  Object.assign(new Error("EACCES: permission denied, open '/x/lockfile.json'"), {
    code: 'EACCES',
  }),
)}${SOFT_SEP}other SPLITBRIEF processes can see the run as running for a few more seconds`;

// The line a leave names for an emptied draft whose old file stays.
const DRAFT_NOT_REMOVED_MESSAGE = sessionError.draftNotRemoved(
  sessionRelativePath(LONG_SESSION_ID, 'draft.json'),
  Object.assign(new Error("EACCES: permission denied, unlink '/x/draft.json'"), { code: 'EACCES' }),
).message;

/**
 * Empties a run's draft over an old `draft.json` its session folder no longer lets SPLITBRIEF
 * remove, through the real flush; the caller names it on its screen. Returns the undo.
 */
export function retainUnremovableDraft(): () => void {
  const ref = { projectDir: VISUAL_FIXTURE_PROJECT_DIR, sessionId: LONG_SESSION_ID };
  writeSessionDraft(ref, createDraftDocument('the old draft'));
  const dir = sessionDir(ref.projectDir, ref.sessionId);
  chmodSync(dir, 0o555);
  saveSessionDraft(ref, createDraftDocument(''));
  flushSessionDrafts();
  return () => {
    chmodSync(dir, 0o755);
    __testDiscardPending();
  };
}

function createDraftNotRemovedFixture(): FixtureLifecycle {
  const home = createHomeFixture();
  let restore: (() => void) | undefined;
  return {
    setup: async (context) => {
      await home.setup(context);
      restore = retainUnremovableDraft();
      nameDraftsNotRemoved('screen');
    },
    teardown: () => {
      restore?.();
      restore = undefined;
      return home.teardown();
    },
  };
}

// A hand edit that names a tool with a typo, read by home's refresh.
const CONFIG_EDIT_REFUSED_MESSAGE =
  'SPLITBRIEF keeps the config it loaded before · Configuration errors in .splitbrief/config.yaml: planner.tool: Invalid option: expected one of "claude-code"|"codex"|"opencode"|"copilot"|"kilo-code"|"cursor"|"command-code"|"antigravity"';

function createConfigEditRefusedFixture(): FixtureLifecycle {
  const home = createHomeFixture();
  return {
    ...home,
    setup: async (context) => {
      await home.setup(context);
      writeFileSync(
        configPath(VISUAL_FIXTURE_PROJECT_DIR),
        readFileSync(configPath(VISUAL_FIXTURE_PROJECT_DIR), 'utf8').replace(
          /tool: claude-code/g,
          'tool: claude-cod',
        ),
      );
    },
  };
}

// The line home shows for the first quit that a draft left on a run could not be saved for.
const DRAFT_NOT_SAVED_MESSAGE = `${UNSAVED_DRAFT_ERROR.message}${SOFT_SEP}quit again leaves without it`;

function createDraftNotSavedFixture(): FixtureLifecycle {
  const home = createHomeFixture();
  return {
    setup: async (context) => {
      await home.setup(context);
      reportDraftNotSaved(UNSAVED_DRAFT_ERROR, true);
    },
    teardown: home.teardown,
  };
}

function setSaveSignInMessage(): void {
  feedbackStore.setMessage(SAVE_SIGN_IN_MESSAGE);
}

// The feedback each home fixture leaves above the composer. The composer locator fits it as the
// composer does, so the crop holds the message rows the home dock counts.
export const homeFixtureFeedback: ReadonlyMap<string, string> = new Map([
  ['home-attachment-not-found', attachmentFailureMessage('not-found')],
  ['home-attachment-not-a-file', attachmentFailureMessage('not-a-file')],
  ['home-attachment-too-large', attachmentFailureMessage('too-large')],
  ['home-attachment-unreadable', attachmentFailureMessage('unreadable')],
  ['home-attachment-not-text', attachmentFailureMessage('not-text')],
  ['home-save-sign-in', SAVE_SIGN_IN_MESSAGE],
  ['home-save-long-draft', SAVE_SIGN_IN_MESSAGE],
  ['home-startup-warnings', STARTUP_WARNINGS_MESSAGE],
  ['home-startup-permission-warning', STARTUP_PERMISSION_WARNING_MESSAGE],
  ['home-draft-not-saved', DRAFT_NOT_SAVED_MESSAGE],
  ['home-draft-not-removed', DRAFT_NOT_REMOVED_MESSAGE],
  ['home-config-edit-refused', CONFIG_EDIT_REFUSED_MESSAGE],
]);

function createSaveSignInFixture(): FixtureLifecycle {
  const home = createHomeFixture({ config: SAVE_SIGN_IN_CONFIG });
  return {
    setup: async (context) => {
      await home.setup(context);
      setSaveSignInMessage();
    },
    teardown: home.teardown,
  };
}

function createSaveLongDraftFixture(): FixtureLifecycle {
  const home = createHomeFixture({ config: SAVE_SIGN_IN_CONFIG });
  return {
    setup: async (context) => {
      await home.setup(context);
      const { seedSessions } = await import('./overlay-fixtures.js');
      seedSessions();
      composerDraftStore.request(LONG_COMPOSER_DRAFT);
      setSaveSignInMessage();
    },
    teardown: home.teardown,
  };
}

function createNoConfigLongDraftFixture(): FixtureLifecycle {
  const home = createHomeFixture({ noConfig: true });
  return {
    setup: async (context) => {
      await home.setup(context);
      const { seedSessions } = await import('./overlay-fixtures.js');
      seedSessions();
      composerDraftStore.request(LONG_COMPOSER_DRAFT);
    },
    teardown: home.teardown,
  };
}

function createOutsideDraftImageFixture(): FixtureLifecycle {
  const home = createHomeFixture();
  return {
    setup: async (context) => {
      await home.setup(context);
      composerDraftStore.requestDocument({
        version: 1,
        parts: [
          { kind: 'text', text: 'fix the overlap shown here ' },
          {
            kind: 'image',
            attachment: {
              id: 'att-outside-visual-1',
              kind: 'image',
              path: '/Users/me/notes/product-planning/receiving-workflow/mock.png',
              mimeType: 'image/png',
              sizeBytes: 48_120,
            },
          },
          { kind: 'text', text: ' and keep the axis labels.' },
        ],
      });
    },
    teardown: home.teardown,
  };
}

// A draft that is not only text: the image sits where the caret put it, between the words that
// explain it, and nothing is parked in a row of its own above the box.
function createDraftImageFixture(): FixtureLifecycle {
  const home = createHomeFixture();
  return {
    setup: async (context) => {
      await home.setup(context);
      composerDraftStore.requestDocument({
        version: 1,
        parts: [
          { kind: 'text', text: 'the legend overlaps the axis here ' },
          {
            kind: 'image',
            attachment: {
              id: 'att-visual-1',
              kind: 'image',
              path: `${VISUAL_FIXTURE_PROJECT_DIR}/docs/usage-panel.png`,
              mimeType: 'image/png',
              sizeBytes: 48_120,
            },
          },
          { kind: 'text', text: ' and again after the first paint ' },
          {
            kind: 'image',
            attachment: {
              id: 'att-visual-2',
              kind: 'image',
              path: `${VISUAL_FIXTURE_PROJECT_DIR}/docs/usage-panel-wide.png`,
              mimeType: 'image/png',
              sizeBytes: 51_904,
            },
          },
          { kind: 'text', text: ' — keep the ticks, move the legend.' },
        ],
      });
    },
    teardown: home.teardown,
  };
}

function createReferenceCompletionFixture(): FixtureLifecycle {
  const home = createHomeFixture();
  let restoreInteractionDeps: (() => void) | null = null;
  return {
    setup: async (context) => {
      await home.setup(context);
      createTestGitRepo(VISUAL_FIXTURE_PROJECT_DIR, {
        'src/app.ts': 'export const app = true;\n',
        'src/components/composer/composer.tsx': 'export const composer = true;\n',
      });
      // The gallery answers the file lookup with an empty list; this menu needs the real one.
      const { previewInteractionDeps } = await import('../gallery/fixture-session.js');
      const previous = previewInteractionDeps.listProjectFiles;
      Object.assign(previewInteractionDeps, { listProjectFiles });
      restoreInteractionDeps = () =>
        Object.assign(previewInteractionDeps, { listProjectFiles: previous });
      composerDraftStore.request('@src');
    },
    teardown: () => {
      restoreInteractionDeps?.();
      restoreInteractionDeps = null;
      return home.teardown();
    },
  };
}

function createRecentSessionsFixture(): FixtureLifecycle {
  const home = createHomeFixture();
  return {
    setup: async (context) => {
      await home.setup(context);
      const { seedSessions } = await import('./overlay-fixtures.js');
      seedSessions();
    },
    teardown: home.teardown,
    afterMount: (write) => write('\u0012'),
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
  [scenarioId('home-no-config'), () => createHomeFixture({ noConfig: true })],
  [
    scenarioId('home-opencode-routes'),
    () => {
      const home = createHomeFixture();
      return {
        ...home,
        setup: async (context) => {
          await home.setup(context);
          seedRoutedCrew();
        },
      };
    },
  ],
  [
    scenarioId('home-kilo-routes'),
    () =>
      createHomeFixture({
        config: {
          planner: { kind: 'cli', tool: 'kilo-code', model: 'github-copilot/gpt-5.5' },
          implementer: { kind: 'cli', tool: 'kilo-code', model: 'openai/gpt-5.5' },
          reviewer: { kind: 'cli', tool: 'kilo-code', model: 'kilo/kilo-auto/free' },
        },
      }),
  ],
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
  [scenarioId('home-cold-detecting'), () => createHomeFixture({ cold: true, detecting: true })],
  [scenarioId('home-cold-failed'), () => createHomeFixture({ cold: true, checkFailed: true })],
  [
    scenarioId('home-cold-crew'),
    () => createHomeFixture({ cold: true, detecting: true, config: VISUAL_WIDE_CREW }),
  ],
  [scenarioId('home-preparing'), createHomePreparingFixture],
  [scenarioId('home-preparation-failed'), createHomePreparationFailedFixture],
  [scenarioId('home-preparation-checkout-warning'), createHomePreparationCheckoutWarningFixture],
  [scenarioId('home-preparation-blocked'), createHomePreparationBlockedFixture],
  [scenarioId('home-preparation-isolation-blocked'), createHomePreparationIsolationBlockedFixture],
  [scenarioId('home-preparation-runner-trust'), createHomePreparationRunnerTrustFixture],
  [scenarioId('home-skills-completion'), createSkillsCompletionFixture],
  [scenarioId('home-palette-prefill-draft'), () => createPalettePrefillFixture(false)],
  [scenarioId('home-palette-prefill-cleared'), () => createPalettePrefillFixture(true)],
  [scenarioId('home-draft-path'), createDraftPathFixture],
  [scenarioId('home-draft-long'), createLongDraftFixture],
  [scenarioId('home-reference-completion'), createReferenceCompletionFixture],
  [scenarioId('home-recent-sessions'), createRecentSessionsFixture],
  [scenarioId('home-draft-image'), createDraftImageFixture],
  [scenarioId('home-draft-outside-image'), createOutsideDraftImageFixture],
  [
    scenarioId('home-attachment-not-found'),
    () => createOutsideAttachmentFailureFixture('not-found'),
  ],
  [
    scenarioId('home-attachment-not-a-file'),
    () => createOutsideAttachmentFailureFixture('not-a-file'),
  ],
  [
    scenarioId('home-attachment-too-large'),
    () => createOutsideAttachmentFailureFixture('too-large'),
  ],
  [
    scenarioId('home-attachment-unreadable'),
    () => createOutsideAttachmentFailureFixture('unreadable'),
  ],
  [scenarioId('home-attachment-not-text'), () => createOutsideAttachmentFailureFixture('not-text')],
  [scenarioId('home-save-sign-in'), createSaveSignInFixture],
  [scenarioId('home-startup-warnings'), () => withStartupWarnings(createHomeFixture())],
  [
    scenarioId('home-startup-permission-warning'),
    () => withStartupWarnings(createHomeFixture(), STARTUP_PERMISSION_WARNING_MESSAGE),
  ],
  [
    scenarioId('home-cold-detecting-startup-warnings'),
    () => withStartupWarnings(createHomeFixture({ cold: true, detecting: true })),
  ],
  [
    scenarioId('home-preparing-startup-warnings'),
    () => withStartupWarnings(createHomePreparingFixture()),
  ],
  [scenarioId('home-draft-not-saved'), createDraftNotSavedFixture],
  [scenarioId('home-draft-not-removed'), createDraftNotRemovedFixture],
  [scenarioId('home-config-edit-refused'), createConfigEditRefusedFixture],
  [scenarioId('home-save-long-draft'), createSaveLongDraftFixture],
  [scenarioId('home-no-config-long-draft'), createNoConfigLongDraftFixture],
  [scenarioId('workflow-continuing'), createWorkflowContinuingFixture],
  [
    scenarioId('workflow-continue-repo-runner-blocked'),
    createWorkflowContinueRepoRunnerBlockedFixture,
  ],
  [scenarioId('workflow-continue-runner-trust'), createWorkflowContinueRunnerTrustFixture],
  [scenarioId('workflow-command-argument'), createCommandArgumentFixture],
  [scenarioId('workflow-removed-command'), createRemovedCommandFixture],
  [scenarioId('setup-initial'), () => createSetupFixture()],
  [scenarioId('setup-saved'), () => createSetupFixture('saved')],
  [scenarioId('setup-saved-ignore-rule'), () => createSetupFixture('saved-ignore-rule')],
  [scenarioId('setup-unavailable-seat'), () => createSetupFixture('unavailable')],
  [scenarioId('setup-signed-out-tools'), () => createSetupFixture('signed-out')],
  [scenarioId('setup-config-only-tool'), () => createSetupFixture('config-only')],
  [scenarioId('setup-api-endpoint-override'), () => createSetupFixture('api-override')],
  [scenarioId('setup-custom-api'), () => createSetupFixture('custom-api')],
  [scenarioId('setup-custom-api-unavailable'), () => createSetupFixture('custom-unavailable')],
  [
    scenarioId('setup-persisted-api-unavailable'),
    () => createSetupFixture('persisted-api-override'),
  ],
  [scenarioId('setup-no-config-detecting'), () => createSetupFixture('detecting')],
  [
    scenarioId('setup-detecting-startup-warnings'),
    () => withStartupWarnings(createSetupFixture('detecting')),
  ],
  [
    scenarioId('setup-saved-detecting-startup-warnings'),
    () => withStartupWarnings(createSetupFixture('saved-detecting')),
  ],
  [scenarioId('setup-no-config-cached-refresh'), () => createSetupFixture('cached-refresh')],
  [scenarioId('setup-no-config-cached-failure'), () => createSetupFixture('cached-failure')],
]);
