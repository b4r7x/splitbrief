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
export const VISUAL_FIXTURE_VERSION = 1;
export const REQUIRED_VIEWPORTS: readonly Viewport[] = Object.freeze([
  viewport({ cols: 120, rows: 40 }),
  viewport({ cols: 80, rows: 24 }),
  viewport({ cols: 60, rows: 18 }),
]);

export const BRIEF_RECOVERY_VIEWPORTS: readonly Viewport[] = Object.freeze([
  viewport({ cols: 121, rows: 16 }),
  viewport({ cols: 120, rows: 16 }),
  viewport({ cols: 119, rows: 16 }),
  viewport({ cols: 80, rows: 16 }),
  viewport({ cols: 50, rows: 16 }),
  viewport({ cols: 40, rows: 16 }),
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
  readonly viewports?: readonly Viewport[];
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

const BRIEF_RECOVERY_SCENARIOS = [
  ['workflow-brief-recovery-zero-task-blocked', 'Zero-task contract blocked', 'CONTRACT BLOCKED'],
  ['workflow-brief-recovery-storage-blocked', 'Storage-blocked contract', 'BECAUSE STORAGE'],
  ['workflow-brief-recovery-task-blocked', 'Task-specific contract blocked', 'QUALITY ISSUE'],
  ['workflow-brief-recovery-retrying-queued', 'Retrying with queued input', 'RETRYING'],
  ['workflow-brief-recovery-unresolved', 'Unresolved retry', 'RETRY UNRESOLVED'],
  ['workflow-brief-recovery-ready', 'Ready after repair', 'CONTRACT READY'],
  ['workflow-brief-recovery-provider-failed', 'Provider failure', 'PROVIDER REFUSAL'],
  ['workflow-brief-recovery-budget-blocked', 'Budget blocked', 'BUDGET REFUSAL'],
] as const satisfies readonly (readonly [string, string, string])[];

const SCREEN_SCENARIOS: Record<Screen, readonly ScenarioDefinition[]> = {
  home: [
    defineScenario({
      id: 'home-empty',
      title: 'Home · empty project',
      surface: screenSurface('home'),
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
  ],
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
    ...BRIEF_RECOVERY_SCENARIOS.map(([id, title, marker]) =>
      defineScenario({
        id,
        title: `Workflow · Brief recovery · ${title}`,
        surface: screenSurface('workflow'),
        viewports: BRIEF_RECOVERY_VIEWPORTS,
        checkpoint: {
          id: 'review',
          title,
          kind: 'review',
          marker,
        },
        elements: [
          { id: 'recovery-public-status', title: 'Recovery public status' },
          { id: 'recovery-status', title: 'Recovery contract status' },
          { id: 'recovery-evidence', title: 'Recovery evidence spine' },
          { id: 'recovery-cause', title: 'Recovery cause explanation' },
          { id: 'recovery-actions', title: 'Recovery action group' },
          { id: 'recovery-composer', title: 'Recovery composer input' },
          { id: 'recovery-body', title: 'Recovery workflow body' },
          { id: 'recovery-sidebar', title: 'Recovery workflow sidebar' },
        ],
      }),
    ),
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
      title: 'Setup · planner selection',
      surface: screenSurface('setup'),
      checkpoint: {
        id: 'ready',
        title: 'Planner setup ready',
        kind: 'ready',
        marker: 'Initializing your tools…',
      },
      elements: [
        { id: 'header', title: 'Setup header' },
        { id: 'setup-panel', title: 'Setup panel' },
      ],
    }),
  ],
};

const OVERLAY_SCENARIOS: Record<OverlaySurface, ScenarioDefinition> = {
  help: defineScenario({
    id: 'overlay-help',
    title: 'Overlay · help',
    surface: overlaySurface('help', 'home'),
    checkpoint: {
      id: 'ready',
      title: 'Help ready',
      kind: 'ready',
      marker: 'Help · commands & shortcuts',
    },
    elements: [{ id: 'overlay-panel', title: 'Help panel' }],
  }),
  'command-palette': defineScenario({
    id: 'overlay-command-palette',
    title: 'Overlay · command palette',
    surface: overlaySurface('command-palette', 'home'),
    checkpoint: {
      id: 'ready',
      title: 'Command palette ready',
      kind: 'ready',
      marker: 'Commands',
    },
    elements: [{ id: 'overlay-panel', title: 'Command palette panel' }],
  }),
  skills: defineScenario({
    id: 'overlay-skills',
    title: 'Overlay · skills',
    surface: overlaySurface('skills', 'home'),
    checkpoint: {
      id: 'ready',
      title: 'Skills ready',
      kind: 'ready',
      marker: 'Skills',
    },
    elements: [{ id: 'overlay-panel', title: 'Skills panel' }],
  }),
  settings: defineScenario({
    id: 'overlay-settings',
    title: 'Overlay · settings',
    surface: overlaySurface('settings', 'home'),
    checkpoint: {
      id: 'ready',
      title: 'Settings ready',
      kind: 'ready',
      marker: 'Settings',
    },
    elements: [{ id: 'overlay-panel', title: 'Settings panel' }],
  }),
  'mode-selector': defineScenario({
    id: 'overlay-mode-selector',
    title: 'Overlay · workflow mode',
    surface: overlaySurface('mode-selector', 'home'),
    checkpoint: {
      id: 'ready',
      title: 'Workflow mode ready',
      kind: 'ready',
      marker: 'Workflow mode',
    },
    elements: [{ id: 'overlay-panel', title: 'Workflow mode panel' }],
  }),
  'planner-picker': defineScenario({
    id: 'overlay-planner-picker',
    title: 'Overlay · planner picker',
    surface: overlaySurface('planner-picker', 'home'),
    checkpoint: {
      id: 'ready',
      title: 'Planner picker ready',
      kind: 'ready',
      marker: 'Tool & model',
    },
    elements: [{ id: 'overlay-panel', title: 'Planner picker panel' }],
  }),
  'implementer-picker': defineScenario({
    id: 'overlay-implementer-picker',
    title: 'Overlay · implementer picker',
    surface: overlaySurface('implementer-picker', 'home'),
    checkpoint: {
      id: 'ready',
      title: 'Implementer picker ready',
      kind: 'ready',
      marker: 'Add custom model',
    },
    elements: [{ id: 'overlay-panel', title: 'Implementer picker panel' }],
  }),
  sessions: defineScenario({
    id: 'overlay-sessions',
    title: 'Overlay · sessions',
    surface: overlaySurface('sessions', 'home'),
    checkpoint: {
      id: 'ready',
      title: 'Sessions ready',
      kind: 'ready',
      marker: 'Sessions',
    },
    elements: [{ id: 'overlay-panel', title: 'Sessions panel' }],
  }),
  editor: defineScenario({
    id: 'overlay-editor',
    title: 'Overlay · editor',
    surface: overlaySurface('editor', 'workflow'),
    checkpoint: {
      id: 'ready',
      title: 'Editor ready',
      kind: 'ready',
      marker: 'Visual fixture plan',
    },
    elements: [{ id: 'overlay-panel', title: 'Editor frame' }],
  }),
  'cost-drilldown': defineScenario({
    id: 'overlay-cost-drilldown',
    title: 'Overlay · cost breakdown',
    surface: overlaySurface('cost-drilldown', 'workflow'),
    checkpoint: {
      id: 'ready',
      title: 'Cost breakdown ready',
      kind: 'ready',
      marker: 'Cost · breakdown',
    },
    elements: [{ id: 'overlay-panel', title: 'Cost breakdown panel' }],
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
  ...ACTIVE_OVERLAYS.map((overlay) => OVERLAY_SCENARIOS[overlay]),
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
