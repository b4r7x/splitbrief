import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { modelCacheStore } from '../../../src/stores/discovery/model-cache/state.js';
import type { RouteData } from '../../../src/stores/navigation/router.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { configStore } from '../../../src/stores/project/config.js';
import { detectionStore } from '../../../src/stores/project/detection.js';
import { skillsStore } from '../../../src/stores/project/skills.js';
import { composerDraftStore } from '../../../src/stores/ui/composer-draft.js';
import {
  CHECKING_TOOLS_STAGE,
  preparationStore,
} from '../../../src/stores/navigation/preparation.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import { resetWorkflow } from '../../../src/stores/workflow/actions/reset.js';
import type { ReadinessCheck, ReadinessReport } from '../../../src/core/readiness/types.js';
import { buildIsolationChecks } from '../../../src/core/readiness/checks/isolation.js';
import { selectNextAction } from '../../../src/core/readiness/status.js';
import type { PreparationOutcome } from '../../../src/engine/runners/prepared-execution.js';
import type { CliToolDetection } from '../../../src/core/discovery/detection.js';
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
}

const HOME_FIXTURE_SKILLS = new Set(['brief-discipline', 'repo-conventions']);

export function createHomeFixture(options: HomeFixtureOptions = {}): FixtureLifecycle {
  return {
    setup: (context) => {
      setupVisualFixture(context);
      if (options.config !== undefined) seedVisualConfig(options.config);
      skillsStore.setSelected(HOME_FIXTURE_SKILLS);
      if (options.cold !== true) publishFreshDiscovery();
      if (options.detecting === true) {
        detectionStore.beginRefresh({ contexts: VISUAL_DETECTION_CONTEXTS });
      }
      routerStore.init({ screen: 'home' });
    },
    teardown: teardownVisualFixture,
  };
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
  summary: 'Planner claude-code can execute commands on this machine.',
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
  [
    scenarioId('home-cold-crew'),
    () => createHomeFixture({ cold: true, detecting: true, config: VISUAL_WIDE_CREW }),
  ],
  [scenarioId('home-preparing'), createHomePreparingFixture],
  [scenarioId('home-preparation-failed'), createHomePreparationFailedFixture],
  [scenarioId('home-preparation-blocked'), createHomePreparationBlockedFixture],
  [scenarioId('home-preparation-isolation-blocked'), createHomePreparationIsolationBlockedFixture],
  [scenarioId('home-skills-completion'), createSkillsCompletionFixture],
  [scenarioId('home-draft-path'), createDraftPathFixture],
  [scenarioId('home-reference-completion'), createReferenceCompletionFixture],
  [scenarioId('home-recent-sessions'), createRecentSessionsFixture],
  [scenarioId('home-draft-image'), createDraftImageFixture],
  [scenarioId('workflow-continuing'), createWorkflowContinuingFixture],
  [scenarioId('workflow-command-argument'), createCommandArgumentFixture],
  [scenarioId('workflow-removed-command'), createRemovedCommandFixture],
  [scenarioId('setup-initial'), createSetupFixture],
]);
