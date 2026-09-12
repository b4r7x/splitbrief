import { ACTIVE_OVERLAYS, ALL_SCREENS, type Screen } from '../../src/core/navigation/types.js';
import {
  ScenarioDefinitionSchema,
  type CheckpointKind,
  type OverlaySurface,
  type ScenarioDefinition,
  type Surface,
} from './contracts/catalog.js';
import { viewport, type Viewport } from './contracts/geometry.js';
import { CATALOG_SCHEMA_VERSION } from './contracts/schema-versions.js';

const CHECKPOINT_TIMEOUT_MS = 10_000;

export const VISUAL_CATALOG_VERSION = CATALOG_SCHEMA_VERSION;
export const VISUAL_FIXTURE_VERSION = 2;
export const REQUIRED_VIEWPORTS: readonly Viewport[] = Object.freeze([
  viewport({ cols: 120, rows: 40 }),
  viewport({ cols: 80, rows: 24 }),
  viewport({ cols: 60, rows: 18 }),
]);

export const HOME_COLD_DETECTING_VIEWPORTS: readonly Viewport[] = Object.freeze([
  viewport({ cols: 80, rows: 40 }),
]);

export const REQUIRED_WORKFLOW_CHECKPOINT_IDS = [
  'idle',
  'planning',
  'implementation',
  'review',
  'question',
  'success',
  'failure',
] as const;

export const REQUIRED_WORKFLOW_CHECKPOINT_KINDS = [
  'idle',
  'planning',
  'implementation',
  'review',
  'question',
  'success',
  'failure',
] as const satisfies readonly CheckpointKind[];

interface CheckpointInput {
  readonly id: string;
  readonly title: string;
  readonly kind: CheckpointKind;
  readonly marker: string;
}

interface ElementInput {
  readonly id: string;
  readonly title: string;
  readonly required?: boolean;
}

interface ScenarioInput {
  readonly id: string;
  readonly title: string;
  readonly surface: Surface;
  readonly checkpoint: CheckpointInput;
  readonly elements: readonly ElementInput[];
  readonly viewports?: readonly Viewport[] | undefined;
}

function defineScenario(input: ScenarioInput): ScenarioDefinition {
  return ScenarioDefinitionSchema.parse({
    id: input.id,
    title: input.title,
    surface: input.surface,
    fixtureVersion: VISUAL_FIXTURE_VERSION,
    viewports: input.viewports ?? REQUIRED_VIEWPORTS,
    checkpoints: [
      {
        ...input.checkpoint,
        timeoutMs: CHECKPOINT_TIMEOUT_MS,
      },
    ],
    elements: input.elements.map((element) => ({
      id: element.id,
      title: element.title,
      required: element.required ?? true,
    })),
  });
}

function screenSurface(screen: Screen): Surface {
  return { kind: 'screen', screen };
}

function overlaySurface(overlay: OverlaySurface, underlyingScreen: Screen): Surface {
  return { kind: 'overlay', overlay, underlyingScreen };
}

interface ScreenScenarioInput {
  readonly id: string;
  readonly title: string;
  readonly viewports?: readonly Viewport[] | undefined;
}

const HOME_SCENARIOS: readonly ScreenScenarioInput[] = [
  { id: 'home-empty', title: 'Home · empty project' },
  { id: 'home-reviewer', title: 'Home · reviewer seat configured' },
  { id: 'home-floor-collapsed', title: 'Home · one-token reviewer' },
  { id: 'home-cold', title: 'Home · detection still cold' },
  {
    id: 'home-cold-detecting',
    title: 'Home · first tool check running',
    viewports: HOME_COLD_DETECTING_VIEWPORTS,
  },
];

const SCREEN_SCENARIOS: Record<Screen, readonly ScenarioDefinition[]> = {
  home: HOME_SCENARIOS.map((home) =>
    defineScenario({
      id: home.id,
      title: home.title,
      surface: screenSurface('home'),
      viewports: home.viewports,
      checkpoint: {
        id: 'ready',
        title: 'Ready for a feature',
        kind: 'ready',
        marker: 'No recent sessions',
      },
      elements: [
        { id: 'header', title: 'Home header' },
        { id: 'hero', title: 'Home hero' },
        { id: 'composer', title: 'Feature composer' },
      ],
    }),
  ),
  workflow: [
    defineScenario({
      id: 'workflow-idle',
      title: 'Workflow · idle',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'idle',
        title: 'Empty workflow',
        kind: 'idle',
        marker: 'no events yet',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Workflow transcript' },
        { id: 'composer', title: 'Workflow composer' },
        { id: 'sidebar', title: 'Workflow sidebar' },
      ],
    }),
    defineScenario({
      id: 'workflow-planning',
      title: 'Workflow · planning',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'planning',
        title: 'Active planning',
        kind: 'planning',
        marker: 'Planning deterministic visual fixtures',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Planning transcript' },
        { id: 'sidebar', title: 'Workflow sidebar' },
      ],
    }),
    defineScenario({
      id: 'workflow-implementation',
      title: 'Workflow · implementation activity',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'implementation',
        title: 'Implementation activity',
        kind: 'implementation',
        marker: 'Inspecting deterministic fixture contract',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Implementation transcript' },
        { id: 'activity', title: 'Implementation activity block' },
        { id: 'sidebar', title: 'Workflow sidebar' },
      ],
    }),
    defineScenario({
      id: 'workflow-review',
      title: 'Workflow · review approval',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'review',
        title: 'Review approval',
        kind: 'review',
        marker: 'Apply bounded visual fixture patch',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Review transcript' },
        { id: 'approval-panel', title: 'Approval panel' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-question',
      title: 'Workflow · clarification question',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'question',
        title: 'Clarification question',
        kind: 'question',
        marker: 'Which fixture answer should be used?',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Question transcript' },
        { id: 'question-panel', title: 'Question panel' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-failure',
      title: 'Workflow · failure and cancellation',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'failure',
        title: 'Terminal failure and cancellation',
        kind: 'failure',
        marker: 'Synthetic runner failure: bounded fixture',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Failure transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-recovery-usage-limit',
      title: 'Workflow · quota halt and seat swap',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'recovery',
        title: 'Usage-limit recovery menu',
        kind: 'question',
        marker: 'switch BUILD to OpenCode CLI',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'question-panel', title: 'Recovery menu panel' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-command-argument',
      title: 'Workflow · command argument completion',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'ready',
        title: 'Command argument completion',
        kind: 'ready',
        marker: '/copy',
      },
      elements: [
        { id: 'composer', title: 'Workflow composer' },
        { id: 'completion', title: 'Command argument completion menu' },
      ],
    }),
  ],
  summary: [
    defineScenario({
      id: 'summary-success',
      title: 'Summary · successful workflow',
      surface: screenSurface('summary'),
      checkpoint: {
        id: 'success',
        title: 'Successful summary',
        kind: 'success',
        marker: 'Visual fixture workflow complete',
      },
      elements: [
        { id: 'header', title: 'Summary header' },
        { id: 'summary-hero', title: 'Summary outcome' },
        { id: 'summary-details', title: 'Summary details' },
      ],
    }),
  ],
  setup: [
    defineScenario({
      id: 'setup-initial',
      title: 'Setup · crew selection',
      surface: screenSurface('setup'),
      checkpoint: {
        id: 'ready',
        title: 'Crew setup ready',
        kind: 'ready',
        marker: 'Set up your crew',
      },
      elements: [
        { id: 'header', title: 'Setup header' },
        { id: 'setup-panel', title: 'Setup panel' },
      ],
    }),
  ],
};

interface OverlayScenarioInput {
  readonly id: string;
  readonly title: string;
  readonly marker: string;
}

interface OverlayGroupInput {
  readonly overlay: OverlaySurface;
  readonly underlyingScreen: Screen;
  readonly panelTitle: string;
  readonly checkpointTitle: string;
  readonly scenarios: readonly OverlayScenarioInput[];
}

function overlayGroup(input: OverlayGroupInput): readonly ScenarioDefinition[] {
  return input.scenarios.map((scenario) =>
    defineScenario({
      id: scenario.id,
      title: scenario.title,
      surface: overlaySurface(input.overlay, input.underlyingScreen),
      checkpoint: {
        id: 'ready',
        title: input.checkpointTitle,
        kind: 'ready',
        marker: scenario.marker,
      },
      elements: [{ id: 'overlay-panel', title: input.panelTitle }],
    }),
  );
}

const PICKER_TITLE_MARKER = 'Tools';

const OVERLAY_SCENARIOS: Record<OverlaySurface, readonly ScenarioDefinition[]> = {
  help: overlayGroup({
    overlay: 'help',
    underlyingScreen: 'workflow',
    panelTitle: 'Help panel',
    checkpointTitle: 'Help ready',
    scenarios: [
      { id: 'overlay-help', title: 'Overlay · help', marker: 'Help · commands & shortcuts' },
    ],
  }),
  'command-palette': overlayGroup({
    overlay: 'command-palette',
    underlyingScreen: 'workflow',
    panelTitle: 'Command palette panel',
    checkpointTitle: 'Command palette ready',
    scenarios: [
      {
        id: 'overlay-command-palette',
        title: 'Overlay · command palette',
        marker: 'Type a command…',
      },
    ],
  }),
  skills: overlayGroup({
    overlay: 'skills',
    underlyingScreen: 'home',
    panelTitle: 'Skills panel',
    checkpointTitle: 'Skills ready',
    scenarios: [{ id: 'overlay-skills', title: 'Overlay · skills', marker: 'Skills' }],
  }),
  settings: overlayGroup({
    overlay: 'settings',
    underlyingScreen: 'home',
    panelTitle: 'Settings panel',
    checkpointTitle: 'Settings ready',
    scenarios: [
      { id: 'overlay-settings', title: 'Overlay · settings', marker: 'Settings' },
      {
        id: 'overlay-settings-crew-full',
        title: 'Overlay · settings · full crew',
        marker: 'Settings',
      },
      {
        id: 'overlay-settings-inherited-effort',
        title: 'Overlay · settings · effort inherited by the reviewer',
        marker: 'Settings',
      },
      {
        id: 'overlay-settings-crew-kilo-copilot',
        title: 'Overlay · settings · Kilo plan seat, Copilot build seat',
        marker: 'Settings',
      },
      {
        id: 'overlay-settings-build-auto-cheapest',
        title: 'Overlay · settings · build seat on price routing',
        marker: 'Settings',
      },
      {
        id: 'overlay-settings-floor-full',
        title: 'Overlay · settings · full crew at the floor',
        marker: 'Settings',
      },
      {
        id: 'overlay-settings-filtered',
        title: 'Overlay · settings · filtered to temperature',
        marker: 'Settings',
      },
      {
        id: 'overlay-settings-filter-plan',
        title: 'Overlay · settings · filtered to plan',
        marker: 'Settings',
      },
      {
        id: 'overlay-settings-filter-workflow',
        title: 'Overlay · settings · filtered to the workflow section',
        marker: 'Settings',
      },
    ],
  }),
  'mode-selector': overlayGroup({
    overlay: 'mode-selector',
    underlyingScreen: 'home',
    panelTitle: 'Workflow mode panel',
    checkpointTitle: 'Workflow mode ready',
    scenarios: [
      { id: 'overlay-mode-selector', title: 'Overlay · workflow mode', marker: 'Workflow mode' },
    ],
  }),
  'planner-picker': overlayGroup({
    overlay: 'planner-picker',
    underlyingScreen: 'home',
    panelTitle: 'Planner picker panel',
    checkpointTitle: 'Planner picker ready',
    scenarios: [
      {
        id: 'overlay-planner-picker',
        title: 'Overlay · planner picker',
        marker: PICKER_TITLE_MARKER,
      },
      {
        id: 'overlay-planner-picker-catalog',
        title: 'Overlay · planner picker · OpenCode catalog',
        marker: PICKER_TITLE_MARKER,
      },
      {
        id: 'overlay-picker-provider-expanded-read',
        title: 'Overlay · planner picker · routes with readable sign-in',
        marker: PICKER_TITLE_MARKER,
      },
      {
        id: 'overlay-picker-claude-effort',
        title: 'Overlay · planner picker · Claude alias effort ladder',
        marker: PICKER_TITLE_MARKER,
      },
      {
        id: 'overlay-picker-claude-effort-set',
        title: 'Overlay · planner picker · Claude alias effort set',
        marker: PICKER_TITLE_MARKER,
      },
      {
        id: 'overlay-picker-provider-expanded-empty',
        title: 'Overlay · planner picker · routes with no signed-in provider',
        marker: PICKER_TITLE_MARKER,
      },
      {
        id: 'overlay-picker-provider-expanded-unreadable',
        title: 'Overlay · planner picker · routes with unknown sign-in',
        marker: PICKER_TITLE_MARKER,
      },
      {
        id: 'overlay-picker-routes-unchecked',
        title: 'Overlay · planner picker · routes with no credential read',
        marker: PICKER_TITLE_MARKER,
      },
      {
        id: 'overlay-planner-picker-cold',
        title: 'Overlay · planner picker · models.dev lane pending',
        marker: PICKER_TITLE_MARKER,
      },
      {
        id: 'overlay-picker-browse-escape',
        title: 'Overlay · implementer picker · browse the wider catalog',
        marker: PICKER_TITLE_MARKER,
      },
      {
        id: 'overlay-planner-picker-no-listing',
        title: 'Overlay · planner picker · tool without model listing',
        marker: PICKER_TITLE_MARKER,
      },
      {
        id: 'overlay-planner-picker-kilo',
        title: 'Overlay · planner picker · Kilo Code catalog sections',
        marker: PICKER_TITLE_MARKER,
      },
      {
        id: 'overlay-planner-picker-kilo-free',
        title: 'Overlay · planner picker · Kilo free routes named apart',
        marker: PICKER_TITLE_MARKER,
      },
      {
        id: 'overlay-planner-picker-malformed',
        title: 'Overlay · planner picker · malformed probe output',
        marker: PICKER_TITLE_MARKER,
      },
      {
        id: 'overlay-planner-picker-claude',
        title: 'Overlay · planner picker · Claude Code alias rows',
        marker: PICKER_TITLE_MARKER,
      },
      {
        id: 'overlay-planner-picker-copilot',
        title: 'Overlay · planner picker · GitHub Copilot models',
        marker: PICKER_TITLE_MARKER,
      },
      {
        id: 'overlay-planner-picker-cursor',
        title: 'Overlay · planner picker · Cursor Agent families',
        marker: PICKER_TITLE_MARKER,
      },
      {
        id: 'overlay-picker-cursor-expanded',
        title: 'Overlay · planner picker · Cursor family axes expanded',
        marker: PICKER_TITLE_MARKER,
      },
      {
        id: 'overlay-picker-opencode-expanded',
        title: 'Overlay · planner picker · OpenCode routes and axes expanded',
        marker: PICKER_TITLE_MARKER,
      },
      {
        id: 'overlay-picker-opencode-expanded-drafted',
        title: 'Overlay · planner picker · OpenCode axis drafted',
        marker: PICKER_TITLE_MARKER,
      },
      {
        id: 'overlay-picker-contract-choice',
        title: 'Overlay · planner picker · custom command contract',
        marker: 'Custom command',
      },
      {
        id: 'overlay-picker-custom-command',
        title: 'Overlay · planner picker · custom command entry',
        marker: 'Custom command',
      },
      {
        id: 'overlay-picker-custom-model',
        title: 'Overlay · planner picker · custom model entry',
        marker: 'Custom model',
      },
    ],
  }),
  'implementer-picker': overlayGroup({
    overlay: 'implementer-picker',
    underlyingScreen: 'home',
    panelTitle: 'Implementer picker panel',
    checkpointTitle: 'Implementer picker ready',
    scenarios: [
      {
        id: 'overlay-implementer-picker',
        title: 'Overlay · implementer picker',
        marker: 'Add custom model',
      },
      {
        id: 'overlay-build-picker-auto-cheapest',
        title: 'Overlay · implementer picker · Auto cheapest capable row',
        marker: PICKER_TITLE_MARKER,
      },
    ],
  }),
  'reviewer-picker': overlayGroup({
    overlay: 'reviewer-picker',
    underlyingScreen: 'home',
    panelTitle: 'Reviewer picker panel',
    checkpointTitle: 'Reviewer picker ready',
    scenarios: [
      {
        id: 'overlay-reviewer-picker-inherited',
        title: 'Overlay · reviewer picker · inherited from the planner',
        marker: PICKER_TITLE_MARKER,
      },
      {
        id: 'overlay-reviewer-picker-tool',
        title: 'Overlay · reviewer picker · tool chosen',
        marker: PICKER_TITLE_MARKER,
      },
    ],
  }),
  sessions: overlayGroup({
    overlay: 'sessions',
    underlyingScreen: 'home',
    panelTitle: 'Sessions panel',
    checkpointTitle: 'Sessions ready',
    scenarios: [{ id: 'overlay-sessions', title: 'Overlay · sessions', marker: 'Sessions' }],
  }),
  editor: overlayGroup({
    overlay: 'editor',
    underlyingScreen: 'workflow',
    panelTitle: 'Editor frame',
    checkpointTitle: 'Editor ready',
    scenarios: [{ id: 'overlay-editor', title: 'Overlay · editor', marker: 'Visual fixture plan' }],
  }),
  'cost-drilldown': overlayGroup({
    overlay: 'cost-drilldown',
    underlyingScreen: 'workflow',
    panelTitle: 'Cost breakdown panel',
    checkpointTitle: 'Cost breakdown ready',
    scenarios: [
      {
        id: 'overlay-cost-drilldown',
        title: 'Overlay · cost breakdown',
        marker: 'Cost · breakdown',
      },
    ],
  }),
};

function createCatalog(scenarios: readonly ScenarioDefinition[]): readonly ScenarioDefinition[] {
  const ids = new Set<string>();
  for (const scenario of scenarios) {
    if (ids.has(scenario.id)) {
      throw new Error(`Duplicate visual scenario ID: ${scenario.id}`);
    }
    ids.add(scenario.id);
  }
  return Object.freeze([...scenarios]);
}

export const VISUAL_CATALOG = createCatalog([
  ...ALL_SCREENS.flatMap((screen) => SCREEN_SCENARIOS[screen]),
  ...ACTIVE_OVERLAYS.flatMap((overlay) => OVERLAY_SCENARIOS[overlay]),
]);

const SCENARIO_BY_ID: ReadonlyMap<string, ScenarioDefinition> = new Map(
  VISUAL_CATALOG.map((scenario) => [scenario.id, scenario]),
);

export function listVisualScenarios(): readonly ScenarioDefinition[] {
  return VISUAL_CATALOG;
}

export function findVisualScenario(id: string): ScenarioDefinition | undefined {
  return SCENARIO_BY_ID.get(id);
}
