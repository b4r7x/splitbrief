import type { OverlayType } from '../../../src/core/navigation/types.js';
import { overlayStore } from '../../../src/stores/ui/overlay.js';
import { editorStore } from '../../../src/stores/ui/editor.js';
import { detectionStore } from '../../../src/stores/project/detection.js';
import { sessionsStore } from '../../../src/stores/project/sessions.js';
import { skillsStore } from '../../../src/stores/project/skills.js';
import { modelCacheStore } from '../../../src/stores/discovery/model-cache.js';
import { reviewStore } from '../../../src/stores/workflow/review.js';
import { tokensStore } from '../../../src/stores/workflow/tokens.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { scenarioId } from '../contracts/identifiers.js';
import { makeSession } from '../../helpers/factories/session.js';
import { makeSummary, makeUsage } from '../../helpers/factories/summary.js';
import type { FixtureFactory, FixtureLifecycle, FixtureRegistry } from './common.js';
import {
  setupVisualFixture,
  teardownVisualFixture,
  VISUAL_FIXTURE_PROJECT_DIR,
} from './screen-fixtures.js';

type OverlaySeed = () => void;
type OverlayUnderlyingScreen = 'home' | 'workflow';

const EMPTY_SEED: OverlaySeed = () => {};

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
    }),
    pricingContext: {
      plannerTool: 'claude-code',
      plannerModel: 'claude-sonnet-4',
      implementerTool: 'ollama',
      implementerModel: 'qwen2.5-coder:7b',
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

function createOverlayFixture(
  overlay: OverlayType,
  seed: OverlaySeed = EMPTY_SEED,
  underlyingScreen: OverlayUnderlyingScreen = 'home',
): FixtureLifecycle {
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
      overlayStore.open(overlay);
    },
    teardown: teardownVisualFixture,
  };
}

const createHelpFixture: FixtureFactory = () => createOverlayFixture('help');
const createPaletteFixture: FixtureFactory = () => createOverlayFixture('command-palette');
const createSkillsFixture: FixtureFactory = () => createOverlayFixture('skills', seedSkills);
const createSettingsFixture: FixtureFactory = () => createOverlayFixture('settings');
const createModeSelectorFixture: FixtureFactory = () => createOverlayFixture('mode-selector');
const createPlannerPickerFixture: FixtureFactory = () => createOverlayFixture('planner-picker');
const createImplementerPickerFixture: FixtureFactory = () =>
  createOverlayFixture('implementer-picker');
const createReviewerPickerFixture: FixtureFactory = () => createOverlayFixture('reviewer-picker');
const createCrewFixture: FixtureFactory = () => createOverlayFixture('crew');
const createSessionsFixture: FixtureFactory = () => createOverlayFixture('sessions', seedSessions);
const createEditorFixture: FixtureFactory = () =>
  createOverlayFixture('editor', seedEditor, 'workflow');
const createCostDrilldownFixture: FixtureFactory = () =>
  createOverlayFixture('cost-drilldown', seedCostBreakdown, 'workflow');

export const overlayFixtureRegistry: FixtureRegistry = new Map([
  [scenarioId('overlay-help'), createHelpFixture],
  [scenarioId('overlay-command-palette'), createPaletteFixture],
  [scenarioId('overlay-skills'), createSkillsFixture],
  [scenarioId('overlay-settings'), createSettingsFixture],
  [scenarioId('overlay-mode-selector'), createModeSelectorFixture],
  [scenarioId('overlay-planner-picker'), createPlannerPickerFixture],
  [scenarioId('overlay-implementer-picker'), createImplementerPickerFixture],
  [scenarioId('overlay-reviewer-picker'), createReviewerPickerFixture],
  [scenarioId('overlay-crew'), createCrewFixture],
  [scenarioId('overlay-sessions'), createSessionsFixture],
  [scenarioId('overlay-editor'), createEditorFixture],
  [scenarioId('overlay-cost-drilldown'), createCostDrilldownFixture],
]);
