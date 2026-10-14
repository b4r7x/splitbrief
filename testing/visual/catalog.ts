import { ACTIVE_OVERLAYS, ALL_SCREENS, type Screen } from '../../src/core/navigation/types.js';
import { BOOT_MANIFEST_TITLE } from '../../src/core/discovery/copy.js';
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

// The focused list spends four rows on its filter box and one on the selection error, so the two
// heights below are the ones that still leave a session row to land the cursor on.
const HOME_RECENT_SESSIONS_VIEWPORTS: readonly Viewport[] = Object.freeze([
  viewport({ cols: 120, rows: 40 }),
  viewport({ cols: 80, rows: 24 }),
]);

// The build-progress block collapses onto two rows at 120 columns and wider, and the sidebar only paints
// past that breakpoint. One wide capture is what proves the two share the row budget.
export const WIDE_VIEWPORTS: readonly Viewport[] = Object.freeze([
  ...REQUIRED_VIEWPORTS,
  viewport({ cols: 160, rows: 45 }),
]);

/**
 * The run screen is the run's home live and at rest, so the gallery has to cover both: the stages
 * a moving run passes through, and every way a run can sit still on that same screen.
 */
export const REQUIRED_WORKFLOW_CHECKPOINT_IDS = [
  'idle',
  'planning',
  'implementation',
  'review',
  'question',
  'failure',
  'at-rest-paused',
  'at-rest-halted',
  'at-rest-waiting',
  'closed-complete',
  'closed-needs-attention',
  'closed-ended',
  'replayed',
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
  readonly checkpoint: CheckpointInput | readonly CheckpointInput[];
  readonly elements: readonly ElementInput[];
  readonly viewports?: readonly Viewport[] | undefined;
}

function defineScenario(input: ScenarioInput): ScenarioDefinition {
  const checkpoints = 'id' in input.checkpoint ? [input.checkpoint] : input.checkpoint;
  return ScenarioDefinitionSchema.parse({
    id: input.id,
    title: input.title,
    surface: input.surface,
    fixtureVersion: VISUAL_FIXTURE_VERSION,
    viewports: input.viewports ?? REQUIRED_VIEWPORTS,
    checkpoints: checkpoints.map((checkpoint) => ({
      ...checkpoint,
      timeoutMs: CHECKPOINT_TIMEOUT_MS,
    })),
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
  { id: 'home-no-config', title: 'Home · no config' },
  { id: 'home-opencode-routes', title: 'Home · same model on different OpenCode routes' },
  { id: 'home-reviewer', title: 'Home · reviewer seat configured' },
  { id: 'home-floor-collapsed', title: 'Home · one-token reviewer' },
  { id: 'home-cold', title: 'Home · detection still cold' },
  {
    id: 'home-cold-detecting',
    title: 'Home · first tool check running',
    viewports: HOME_COLD_DETECTING_VIEWPORTS,
  },
  {
    id: 'home-cold-crew',
    title: 'Home · first discovery with a wide crew',
    viewports: [...REQUIRED_VIEWPORTS, viewport({ cols: 200, rows: 50 })],
  },
];

const SCREEN_SCENARIOS: Record<Screen, readonly ScenarioDefinition[]> = {
  home: [
    ...HOME_SCENARIOS.map((home) =>
      defineScenario({
        id: home.id,
        title: home.title,
        surface: screenSurface('home'),
        viewports: home.viewports,
        checkpoint: {
          id: 'ready',
          title: 'Ready for a feature',
          kind: 'ready',
          marker: 'Describe your feature…',
        },
        elements: [
          { id: 'header', title: 'Home header' },
          { id: 'hero', title: 'Home hero' },
          { id: 'composer', title: 'Feature composer' },
        ],
      }),
    ),
    // The draft replaces the shared home placeholder, so this scenario waits on the open menu's
    // own footer instead of reusing the `Describe your feature…` marker.
    defineScenario({
      id: 'home-skills-completion',
      title: 'Home · /skills completion menu',
      surface: screenSurface('home'),
      checkpoint: {
        id: 'ready',
        title: 'Skills completion open',
        kind: 'ready',
        marker: 'tab fill',
      },
      elements: [
        { id: 'composer', title: 'Feature composer' },
        { id: 'completion', title: 'Skills completion menu' },
      ],
    }),
    defineScenario({
      id: 'home-draft-path',
      title: 'Home · a pasted absolute path in the draft',
      surface: screenSurface('home'),
      checkpoint: {
        id: 'ready',
        title: 'Draft holding an absolute path',
        kind: 'ready',
        marker: 'plan from this brief',
      },
      elements: [
        { id: 'header', title: 'Home header' },
        { id: 'composer', title: 'Feature composer' },
      ],
    }),
    // A check running behind a live composer: the status borrows the hint's row and the draft the
    // operator submitted is still theirs to edit.
    defineScenario({
      id: 'home-preparing',
      title: 'Home · checking tools beside a live draft',
      surface: screenSurface('home'),
      checkpoint: {
        id: 'ready',
        title: 'Check running beside the composer',
        kind: 'ready',
        marker: 'Checking tools',
      },
      elements: [
        { id: 'header', title: 'Home header' },
        { id: 'composer', title: 'Feature composer' },
      ],
    }),
    // The panel appears only when preparation needs an answer.
    defineScenario({
      id: 'home-preparation-failed',
      title: 'Home · preparation failed with no blocker',
      surface: screenSurface('home'),
      checkpoint: {
        id: 'failure',
        title: 'Failed with warnings only',
        kind: 'failure',
        marker: 'Session ownership could not be taken over',
      },
      elements: [{ id: 'preparation-panel', title: 'Preparation problem panel' }],
    }),
    // The composer carrying images inside its text: no separate attachment row, no extra height.
    defineScenario({
      id: 'home-preparation-blocked',
      title: 'Home · preparation needs a local server',
      surface: screenSurface('home'),
      checkpoint: {
        id: 'failure',
        title: 'Offline server prevents start',
        kind: 'failure',
        marker: 'Ollama is not reachable',
      },
      elements: [{ id: 'preparation-panel', title: 'Preparation problem panel' }],
    }),
    // The readiness blocker that recommends the checkout: its summary and fix line come from
    // `buildIsolationChecks`, not from this catalog.
    defineScenario({
      id: 'home-preparation-isolation-blocked',
      title: 'Home · preparation blocked by workspace links',
      surface: screenSurface('home'),
      checkpoint: {
        id: 'failure',
        title: 'Workspace links recommend the checkout',
        kind: 'failure',
        marker: 'The project links workspace packages',
      },
      elements: [{ id: 'preparation-panel', title: 'Preparation problem panel' }],
    }),
    defineScenario({
      id: 'home-draft-image',
      title: 'Home · a draft with images at the caret',
      surface: screenSurface('home'),
      checkpoint: {
        id: 'ready',
        title: 'Draft holding two images',
        kind: 'ready',
        marker: '[image #2]',
      },
      elements: [
        { id: 'header', title: 'Home header' },
        { id: 'composer', title: 'Feature composer' },
      ],
    }),
    defineScenario({
      id: 'home-reference-completion',
      title: 'Home · @ reference completion menu',
      surface: screenSurface('home'),
      checkpoint: {
        id: 'ready',
        title: 'Reference completion open',
        kind: 'ready',
        marker: 'tab/⏎ fill',
      },
      elements: [
        { id: 'composer', title: 'Feature composer' },
        { id: 'completion', title: 'Reference completion menu' },
      ],
    }),
    defineScenario({
      id: 'home-draft-outside-image',
      title: 'Home · draft with an outside image',
      surface: screenSurface('home'),
      checkpoint: {
        id: 'ready',
        title: 'Outside image between draft text',
        kind: 'ready',
        marker: '[image #1]',
      },
      elements: [
        { id: 'header', title: 'Home header' },
        { id: 'composer', title: 'Feature composer' },
      ],
    }),
    ...(['not-found', 'not-a-file', 'too-large', 'unreadable', 'not-text'] as const).map((reason) =>
      defineScenario({
        id: `home-attachment-${reason}`,
        title: `Home · outside attachment refused: ${reason}`,
        surface: screenSurface('home'),
        checkpoint: {
          id: 'failure',
          title: `Draft retained after ${reason}`,
          kind: 'failure',
          marker: 'Cannot send:',
        },
        elements: [{ id: 'composer', title: 'Draft and attachment feedback' }],
      }),
    ),
    defineScenario({
      id: 'home-recent-sessions',
      title: 'Home · recent sessions focused',
      surface: screenSurface('home'),
      viewports: HOME_RECENT_SESSIONS_VIEWPORTS,
      checkpoint: {
        id: 'ready',
        title: 'Recent sessions focused',
        kind: 'ready',
        marker: 'y copy',
      },
      elements: [{ id: 'composer', title: 'Feature composer' }],
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
        marker: 'Keep the public API?',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Planning transcript' },
        { id: 'sidebar', title: 'Workflow sidebar' },
      ],
    }),
    defineScenario({
      id: 'workflow-start-attached-files',
      title: 'Workflow · start with attached files',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'start-attached-files',
        title: 'The first request names the attached files',
        kind: 'planning',
        marker: 'Attached files',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Request and attached files' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-composer-outside-file',
      title: 'Workflow · composer message with an outside file',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'composer-outside-file',
        title: 'Mid-run message with attached text',
        kind: 'planning',
        marker: 'Attached files · 1',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Message and attached file' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-question-outside-file',
      title: 'Workflow · answered question with an outside file',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'question-outside-file',
        title: 'Answered question followed by its attachment',
        kind: 'planning',
        marker: 'Attached files · 1',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Answered question and attached file' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-planning-path-notice',
      title: 'Workflow · plan seat names a path it cannot open',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'planning-path-notice',
        title: 'API path notice before planning',
        kind: 'planning',
        marker: 'cannot open',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Planning transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-plan-compiled',
      title: 'Workflow · plan compiled',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'plan-compiled',
        title: 'The planning session writes plan.md and tasks.md from plan.json',
        kind: 'planning',
        marker: 'Planning…',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Plan transcript' },
      ],
    }),
    defineScenario({
      id: 'workflow-first-brief-after-plan',
      title: 'Workflow · first brief running after a real plan',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'first-brief-after-plan',
        title: 'The settled Plan and first running brief with no passed briefs',
        kind: 'implementation',
        marker: '0/3 briefs passed',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Plan ledger and running brief' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-implementation',
      title: 'Workflow · implementation activity',
      surface: screenSurface('workflow'),
      viewports: [...WIDE_VIEWPORTS, viewport({ cols: 220, rows: 45 })],
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
      id: 'workflow-resuming',
      title: 'Workflow · a continued run before its first call',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'resuming',
        title: 'The byline says the run is resuming, not paused',
        kind: 'implementation',
        marker: 'Resuming',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-implementation-queued',
      title: 'Workflow · a message queued for the running brief',
      surface: screenSurface('workflow'),
      viewports: REQUIRED_VIEWPORTS,
      checkpoint: {
        id: 'implementation-queued',
        title: 'Message queued for BUILD',
        kind: 'implementation',
        marker: '1 queued for BUILD on T003',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Queued message transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-implementation-delivered',
      title: 'Workflow · a message delivered to the running brief',
      surface: screenSurface('workflow'),
      viewports: REQUIRED_VIEWPORTS,
      checkpoint: {
        id: 'implementation-delivered',
        title: 'Message delivered to BUILD',
        kind: 'implementation',
        marker: 'Delivered',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Delivered message transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-implementation-steerable',
      title: 'Workflow · a message delivered during the running BUILD call',
      surface: screenSurface('workflow'),
      viewports: REQUIRED_VIEWPORTS,
      checkpoint: {
        id: 'implementation-steerable',
        title: 'Mid-call delivery to BUILD',
        kind: 'implementation',
        marker: 'Delivered',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Mid-call delivery transcript' },
        { id: 'composer', title: 'Steerable workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-crew-wide',
      title: 'Workflow · a wide crew during implementation',
      surface: screenSurface('workflow'),
      viewports: [...WIDE_VIEWPORTS, viewport({ cols: 200, rows: 50 })],
      checkpoint: {
        id: 'implementation',
        title: 'Implementation with wrapped seats',
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
      id: 'workflow-build-consult',
      title: 'Workflow · planner consult during the build',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'build-consult',
        title: 'The planner answers a consult on the running brief',
        kind: 'implementation',
        marker: 'answering the consult on T901',
      },
      elements: [
        { id: 'header', title: 'Build progress' },
        { id: 'transcript', title: 'Running brief' },
      ],
    }),
    defineScenario({
      id: 'workflow-build-review-consult',
      title: 'Workflow · reviewer consult on a fix task',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'build-review-consult',
        title: 'The reviewer answers the consult of its fix task',
        kind: 'implementation',
        marker: 'answering the consult on T904',
      },
      elements: [
        { id: 'header', title: 'Build progress' },
        { id: 'transcript', title: 'Fix brief with the reviewer consult row' },
      ],
    }),
    defineScenario({
      id: 'workflow-implementation-extracted-code',
      title: 'Workflow · extracted-code output stays plain',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'implementation-extracted-code',
        title: 'Plain file bundle output',
        kind: 'implementation',
        marker: 'file-bundle-v1',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Extracted-code transcript' },
      ],
    }),
    defineScenario({
      id: 'workflow-implementation-narration',
      title: 'Workflow · a Claude Code build call narrating between tool calls',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'implementation-narration',
        title: 'Build narration around a tool call',
        kind: 'implementation',
        marker: 'BUILD activity',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Implementation transcript' },
        { id: 'activity', title: 'Implementation activity block' },
      ],
    }),
    defineScenario({
      id: 'workflow-continuous-transcript',
      title: 'Workflow · completed briefs retain their body before the running brief',
      surface: screenSurface('workflow'),
      viewports: [...WIDE_VIEWPORTS, viewport({ cols: 200, rows: 50 })],
      checkpoint: {
        id: 'continuous-transcript',
        title: 'Plan and two completed briefs before T003',
        kind: 'implementation',
        marker: 'T003 Test the receiving flow',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Continuous transcript' },
        { id: 'sidebar', title: 'Workflow sidebar' },
      ],
    }),
    defineScenario({
      id: 'workflow-implementation-adjacent-narration',
      title: 'Workflow · two build messages without a tool call between them',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'implementation-adjacent-narration',
        title: 'Adjacent build narration',
        kind: 'implementation',
        marker: 'I run the two brief checks now.',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Implementation transcript' },
        { id: 'activity', title: 'Implementation activity block' },
      ],
    }),
    defineScenario({
      id: 'workflow-implementation-fenced-handback',
      title: 'Workflow · a build hand-back fenced as a json code block',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'implementation-fenced-handback',
        title: 'Fenced hand-back report',
        kind: 'implementation',
        marker: 'Report  done',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Implementation transcript' },
        { id: 'activity', title: 'Implementation activity block' },
      ],
    }),
    defineScenario({
      id: 'workflow-review-fix',
      title: 'Workflow · the fix task the review appended',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'review-fix',
        title: 'Review fix task',
        kind: 'implementation',
        marker: '3/4 briefs passed',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Implementation transcript' },
        { id: 'sidebar', title: 'Workflow sidebar', required: false },
      ],
    }),
    defineScenario({
      id: 'workflow-review-fix-cycles',
      viewports: WIDE_VIEWPORTS,
      title: 'Workflow · settled review cycles and their fix briefs',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'review-fix-cycles',
        title: 'Settled ledger above the live review',
        kind: 'implementation',
        marker: '4/4 briefs passed',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Review cycle transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-complete-after-fix-tasks',
      title: 'Workflow · complete after the review appended a fix task',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'complete-after-fix-tasks',
        title: 'Every brief counted once',
        kind: 'implementation',
        marker: '4/4 briefs passed',
      },
      elements: [{ id: 'header', title: 'Workflow header' }],
    }),
    defineScenario({
      id: 'workflow-review-fix-no-change',
      title: 'Workflow · a fix brief that needed no change',
      surface: screenSurface('workflow'),
      viewports: WIDE_VIEWPORTS,
      checkpoint: {
        id: 'review-fix-no-change',
        title: 'Review fix verified without a change',
        kind: 'implementation',
        marker: 'no change needed',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Implementation transcript' },
        { id: 'sidebar', title: 'Workflow sidebar' },
      ],
    }),
    defineScenario({
      id: 'workflow-final-review',
      title: 'Workflow · final review running',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'final-review',
        title: 'Final review',
        kind: 'implementation',
        marker: '3/3 briefs passed',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Review transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    ...(['', '-settled'] as const).map((suffix) =>
      defineScenario({
        id: `workflow-review-task-cadence${suffix}`,
        title: `Workflow · task reviews${suffix === '' ? ' running' : ' at rest'}`,
        surface: screenSurface('workflow'),
        checkpoint: {
          id: `review-task-cadence${suffix}`,
          title:
            suffix === ''
              ? 'Task review running after the second brief'
              : 'Task and final reviews replayed at rest',
          kind: 'implementation',
          marker: suffix === '' ? 'Review T001 passed' : 'Final review passed',
        },
        viewports: WIDE_VIEWPORTS,
        elements: [
          { id: 'header', title: 'Workflow header' },
          { id: 'transcript', title: 'Task review transcript' },
          { id: 'composer', title: 'Workflow composer' },
          { id: 'sidebar', title: 'Workflow sidebar', required: false },
        ],
      }),
    ),
    defineScenario({
      id: 'workflow-review-task-out-of-scope',
      title: 'Workflow · task review with only out-of-scope notes',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'review-task-out-of-scope',
        title: 'Task review passed with out-of-scope notes',
        kind: 'implementation',
        marker: 'Review T001 passed',
      },
      viewports: WIDE_VIEWPORTS,
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Task review transcript' },
        { id: 'composer', title: 'Workflow composer' },
        { id: 'sidebar', title: 'Workflow sidebar', required: false },
      ],
    }),
    defineScenario({
      id: 'workflow-review-settled-passed',
      viewports: WIDE_VIEWPORTS,
      title: 'Workflow · terminal Review passed',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'review-settled-passed',
        title: 'Settled terminal Review',
        kind: 'implementation',
        marker: 'Final review passed',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Settled Review transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-review-resumed',
      title: 'Workflow · review continued after interruption',
      surface: screenSurface('workflow'),
      viewports: [...REQUIRED_VIEWPORTS, viewport({ cols: 120, rows: 60 })],
      checkpoint: {
        id: 'review-resumed',
        title: 'Two review attempts',
        kind: 'implementation',
        marker: 'Run continued',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Review attempts' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-review-choosing-checks',
      title: 'Workflow · reviewer choosing checks',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'review-choosing-checks',
        title: 'Reviewer check selection',
        kind: 'implementation',
        marker: 'choosing checks',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Review transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-review-verdict-only',
      title: 'Workflow · reviewer answers after a question',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'review-verdict-only',
        title: 'Reviewer verdict',
        kind: 'implementation',
        marker: 'reviewing changes',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'composer', title: 'Review activity' },
      ],
    }),
    defineScenario({
      id: 'workflow-review-check-crash',
      title: 'Workflow · review continued after a check crash',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'review-check-crash',
        title: 'Review attempts',
        kind: 'implementation',
        marker: 'Run continued',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Review attempts' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-review-drift-clean',
      title: 'Workflow · reviewer checks then a clean drift',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'review-drift-clean',
        title: 'Reviewer checks followed by clean drift',
        kind: 'review',
        marker: 'Drift · clean',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Reviewer checks and drift transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-review-drift-found',
      title: 'Workflow · reviewer checks then drift with findings',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'review-drift-found',
        title: 'Failed reviewer check followed by drift findings',
        kind: 'review',
        marker: 'Drift · failed',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Reviewer checks and drift transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-continuous-transcript-ready',
      title: 'Workflow · ready run retains plan and reviewer check rows',
      surface: screenSurface('workflow'),
      viewports: [...WIDE_VIEWPORTS, viewport({ cols: 200, rows: 50 })],
      checkpoint: {
        id: 'continuous-transcript-ready',
        title: 'Plan, two completed briefs and Final review passed at rest',
        kind: 'success',
        marker: 'Apply',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Continuous ready transcript' },
        { id: 'sidebar', title: 'Workflow sidebar' },
      ],
    }),
    defineScenario({
      id: 'workflow-review-settled-failed',
      viewports: WIDE_VIEWPORTS,
      title: 'Workflow · terminal Review failed',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'review-settled-failed',
        title: 'Settled terminal Review',
        kind: 'implementation',
        marker: 'Final review failed',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Settled Review transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-review-corrected',
      viewports: WIDE_VIEWPORTS,
      title: 'Workflow · skipped brief and a corrected review',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'review-corrected',
        title: 'Each finished brief and review has its own row',
        kind: 'implementation',
        marker: 'Final review re-run passed',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Settled brief and review transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    ...(['summary', 'compaction'] as const).map((role) =>
      defineScenario({
        id: `workflow-review-${role}`,
        title: `Workflow · ${role} during Review`,
        surface: screenSurface('workflow'),
        checkpoint: {
          id: `review-${role}`,
          title: 'Actual running step',
          kind: 'implementation',
          marker: role === 'summary' ? 'Review · Summary' : 'Review · Compaction',
        },
        elements: [
          { id: 'header', title: 'Workflow header' },
          { id: 'transcript', title: 'Review transcript' },
          { id: 'composer', title: 'Workflow composer' },
        ],
      }),
    ),
    defineScenario({
      id: 'workflow-review-checks-off',
      title: 'Workflow · final review with End-of-run checks off',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'review-checks-off',
        title: 'The off row above the running review',
        kind: 'implementation',
        marker: 'End-of-run checks',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Review transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-implementation-retry',
      title: 'Workflow · brief after an attempt allowance grant',
      surface: screenSurface('workflow'),
      viewports: WIDE_VIEWPORTS,
      checkpoint: {
        id: 'implementation-retry',
        title: 'Retried brief',
        kind: 'implementation',
        marker: 'attempt 7 of 12',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Implementation transcript' },
        { id: 'sidebar', title: 'Workflow sidebar' },
      ],
    }),
    defineScenario({
      id: 'workflow-implementation-after-retry',
      title: 'Workflow · the brief after a retried one',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'implementation-after-retry',
        title: 'Next brief after a retried brief',
        kind: 'implementation',
        marker: 'Register the bounded fixture projection',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Implementation transcript' },
      ],
    }),
    defineScenario({
      id: 'workflow-validation',
      title: 'Workflow · gate verdicts of a session from before reviewer checks',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'validation',
        title: 'Validation verdicts',
        kind: 'implementation',
        marker: 'lint pre-existing failure',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Validation transcript' },
        { id: 'sidebar', title: 'Workflow sidebar' },
      ],
    }),
    defineScenario({
      id: 'workflow-touched-not-suggested',
      title: 'Workflow · a brief that also changed unsuggested files',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'touched-not-suggested',
        title: 'Touched, not suggested',
        kind: 'implementation',
        marker: 'also changed',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Implementation transcript' },
        { id: 'sidebar', title: 'Workflow sidebar' },
      ],
    }),
    defineScenario({
      id: 'workflow-plan-check-refused',
      title: 'Workflow · a plan check the command policy refused',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'plan-check-refused',
        title: 'A refused plan check row with its reason',
        kind: 'implementation',
        marker: 'Plan check K2',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Implementation transcript' },
        { id: 'sidebar', title: 'Workflow sidebar' },
      ],
    }),
    defineScenario({
      id: 'workflow-completed-orphan-rows',
      title: 'Workflow · completed briefs retain run-level and boundary rows',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'completed-orphan-rows',
        title: 'Earlier brief content stays above the live brief',
        kind: 'implementation',
        marker: '1/3 briefs passed',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Implementation transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-planner-commands-refused',
      title: 'Workflow · a test command not taken from the planner',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'planner-commands-refused',
        title: 'Refused planner command',
        kind: 'planning',
        marker: 'The test checks do not take',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Planning transcript' },
      ],
    }),
    defineScenario({
      id: 'workflow-review-fix-narrow-rail',
      title: 'Workflow · inserted review fixes in the narrow rail',
      surface: screenSurface('workflow'),
      viewports: [viewport({ cols: 22, rows: 45 }), viewport({ cols: 160, rows: 45 })],
      checkpoint: [
        {
          id: 'review-fix-narrow-rail',
          title: 'Inserted review fix running with build progress',
          kind: 'implementation',
          marker: '4/7 briefs passed',
        },
        {
          id: 'review-fix-narrow-rail-stop',
          title: 'Inserted review fix with stop options open',
          kind: 'implementation',
          marker: 'Stop options',
        },
      ],
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Implementation transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-task-statuses',
      title: 'Workflow · escalated, failed and skipped briefs',
      surface: screenSurface('workflow'),
      viewports: [viewport({ cols: 160, rows: 45 }), viewport({ cols: 80, rows: 24 })],
      checkpoint: {
        id: 'task-statuses',
        title: 'Sidebar status column',
        kind: 'implementation',
        marker: '1/7 briefs passed',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Implementation transcript' },
        { id: 'sidebar', title: 'Workflow sidebar' },
      ],
    }),
    defineScenario({
      id: 'workflow-implementation-escalated',
      title: 'Workflow · escalated brief',
      surface: screenSurface('workflow'),
      viewports: WIDE_VIEWPORTS,
      checkpoint: {
        id: 'implementation-escalated',
        title: 'Escalated brief',
        kind: 'implementation',
        marker: '1 escalated',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Implementation transcript' },
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
        marker: 'Change a package manifest:',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Review transcript' },
        { id: 'approval-panel', title: 'Approval panel' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-approval-confirm',
      title: 'Workflow · destructive confirm gate',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'approval-confirm',
        title: 'Confirm gate',
        kind: 'review',
        marker: 'Destructive action:',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Implementation transcript' },
        { id: 'approval-panel', title: 'Confirm panel' },
      ],
    }),
    defineScenario({
      id: 'workflow-approval-confirm-secret',
      title: 'Workflow · CI or secret file confirm gate',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'approval-confirm-secret',
        title: 'Secret file confirm gate',
        kind: 'review',
        marker: 'Change a CI or secret file:',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Implementation transcript' },
        { id: 'approval-panel', title: 'Confirm panel' },
      ],
    }),
    defineScenario({
      id: 'workflow-plan-card',
      title: 'Workflow · plan card',
      surface: screenSurface('workflow'),
      viewports: WIDE_VIEWPORTS,
      checkpoint: {
        id: 'plan-card',
        title: 'Plan card',
        kind: 'review',
        marker: 'Approve plan and start the build',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Plan transcript' },
        { id: 'approval-panel', title: 'Plan card panel' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    // A plan whose render checks have no validation.render: the card opens with the note.
    defineScenario({
      id: 'workflow-plan-card-render-note',
      title: 'Workflow · plan card naming render checks with no render command',
      surface: screenSurface('workflow'),
      viewports: WIDE_VIEWPORTS,
      checkpoint: {
        id: 'plan-card-render-note',
        title: 'Plan card with the render note',
        kind: 'review',
        marker: 'Approve plan and start the build',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Plan transcript' },
        { id: 'approval-panel', title: 'Plan card panel' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    // Two run checks under different ids run one command: the confirms line names it once.
    defineScenario({
      id: 'workflow-plan-card-shared-command',
      title: 'Workflow · plan card whose checks share one command',
      surface: screenSurface('workflow'),
      viewports: WIDE_VIEWPORTS,
      checkpoint: {
        id: 'plan-card-shared-command',
        title: 'Plan card with one command under two check ids',
        kind: 'review',
        marker: 'Approve plan and start the build',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Plan transcript' },
        { id: 'approval-panel', title: 'Plan card panel' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    // Seven briefs as `formatTasks` persists them, two with headers past twelve lines: the card
    // lists every one of them.
    defineScenario({
      id: 'workflow-tasks-card',
      title: 'Workflow · tasks card with long brief headers',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'tasks-card',
        title: 'Tasks card listing every brief',
        kind: 'planning',
        marker: 'T007',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Tasks card transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-question',
      title: 'Workflow · clarification question',
      surface: screenSurface('workflow'),
      viewports: WIDE_VIEWPORTS,
      checkpoint: {
        id: 'question',
        title: 'Clarification question',
        kind: 'question',
        marker: 'Question 1 of 3',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Question transcript' },
        { id: 'question-panel', title: 'Question panel' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-reviewer-question',
      title: 'Workflow · reviewer consult question',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'reviewer-question',
        title: 'The reviewer asks about its repair task',
        kind: 'question',
        marker: 'Reply to the reviewer',
      },
      elements: [
        { id: 'transcript', title: 'Reviewer consult' },
        { id: 'composer', title: 'Reply to the reviewer' },
      ],
    }),
    defineScenario({
      id: 'workflow-question-input',
      title: 'Workflow · answer inside the question',
      surface: screenSurface('workflow'),
      viewports: WIDE_VIEWPORTS,
      checkpoint: {
        id: 'question-input',
        title: 'Inline answer and separate instruction',
        kind: 'question',
        marker: 'Question 1 of 2',
      },
      elements: [
        { id: 'question-panel', title: 'Question panel' },
        { id: 'composer', title: 'New instruction' },
      ],
    }),
    defineScenario({
      id: 'workflow-question-overflow',
      title: 'Workflow · revisiting a long answer',
      surface: screenSurface('workflow'),
      viewports: WIDE_VIEWPORTS,
      checkpoint: {
        id: 'question-overflow',
        title: 'Previous answer with overflowing option',
        kind: 'question',
        marker: 'Question 2 of 3',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'question-panel', title: 'Question panel' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-planner-reply',
      title: 'Workflow · ordinary planner reply',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'planner-reply',
        title: 'Waiting for scope',
        kind: 'question',
        marker: 'Which module should change?',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Planner reply' },
        { id: 'composer', title: 'Reply composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-question-answered',
      title: 'Workflow · answered structured questions',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'question-answered',
        title: 'Answered structured questions',
        kind: 'question',
        marker: 'Simplify/clean up existing code',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Answered questions transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-consult-answer-default',
      title: 'Workflow · consult default accepted with Enter',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'consult-answer-default',
        title: 'Consult answer in its brief',
        kind: 'question',
        marker: 'You → memory',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Consult answer transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-decision-question',
      title: 'Workflow · planner asks about a reported decision',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'decision-question',
        title: "The question shows the brief's operator instructions",
        kind: 'question',
        marker: 'Did you ask for greet',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Decision confirm transcript' },
        { id: 'question-panel', title: 'Question panel' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-decision-guidance',
      title: 'Workflow · planner guidance after the user answered',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'decision-guidance',
        title: 'Question, answer and guidance rows of one decision confirm',
        kind: 'implementation',
        marker: 'guidance',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Decision confirm transcript' },
      ],
    }),
    defineScenario({
      id: 'workflow-consult-answer-typed',
      title: 'Workflow · typed consult answer',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'consult-answer-typed',
        title: 'Consult answer in its brief',
        kind: 'question',
        marker: 'You → redis',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Consult answer transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-paused-mid-brief',
      title: 'Workflow · parked mid-brief',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'paused-mid-brief',
        title: 'Parked mid-brief',
        kind: 'question',
        marker: 'Stopped at T',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Implementation transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-paused-boundary',
      title: 'Workflow · parked at a brief boundary',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'paused-boundary',
        title: 'Parked at a boundary',
        kind: 'question',
        marker: 'Stopped before T902',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Implementation transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-selection-copy',
      title: 'Workflow · selection copied at a gate',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'selection-copy',
        title: 'Selection copy receipt',
        kind: 'ready',
        marker: 'Copied (native)',
      },
      elements: [{ id: 'composer', title: 'Workflow composer' }],
    }),
    defineScenario({
      id: 'workflow-quit-hint',
      title: 'Workflow · quit confirmation',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'quit-hint',
        title: 'Quit confirmation',
        kind: 'ready',
        marker: 'Press ctrl+c again to quit',
      },
      elements: [{ id: 'composer', title: 'Workflow composer' }],
    }),
    defineScenario({
      id: 'workflow-stopping',
      title: 'Workflow · stopping',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'stopping',
        title: 'Stopping the run',
        kind: 'implementation',
        marker: 'Finishing cleanup and saving',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Implementation transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-at-rest-paused',
      title: 'Workflow · a paused run at rest',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'at-rest-paused',
        title: 'Paused run at rest',
        kind: 'ready',
        marker: 'Stopped at',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Replayed transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-at-rest-queued',
      title: 'Workflow · a reopened run with an unread message',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'at-rest-queued',
        title: 'The count excludes a message already read by REVIEW',
        kind: 'ready',
        marker: '1 queued',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'composer', title: 'Workflow composer and queued count' },
      ],
    }),
    defineScenario({
      id: 'workflow-at-rest-long-park',
      title: 'Workflow · a run at rest after a night stopped',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'at-rest-long-park',
        title: 'Run clock without the park',
        kind: 'ready',
        marker: 'Stopped at',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Replayed transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-at-rest-quick',
      title: 'Workflow · an old quick run paused at rest',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'at-rest-paused',
        title: 'An old quick run at rest; continuing it runs one planning session',
        kind: 'ready',
        marker: 'a correction or ⏎ to continue',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Replayed transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-at-rest-halted',
      title: 'Workflow · a halted run at rest',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'at-rest-halted',
        title: 'Halted run at rest',
        kind: 'ready',
        marker: 'Seat down · Quota spent on Ollama',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Replayed transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-at-rest-closed-elsewhere',
      title: 'Workflow · a paused run that another process ended',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'at-rest-closed-elsewhere',
        title: 'The screen follows the ended run without input',
        kind: 'failure',
        marker: 'visual-at-rest-closed-elsewhere',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Closed run ledger' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-at-rest-crashed-build',
      title: 'Workflow · a run whose process went away during a brief',
      surface: screenSurface('workflow'),
      viewports: WIDE_VIEWPORTS,
      checkpoint: {
        id: 'at-rest-crashed-build',
        title: 'The cut BUILD call reads as interrupted',
        kind: 'ready',
        marker: 'interrupted',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Replayed transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-at-rest-crashed-review',
      title: 'Workflow · a run whose process went away during the final review',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'at-rest-crashed-review',
        title: 'The cut REVIEW call reads as interrupted',
        kind: 'ready',
        marker: 'interrupted',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Replayed transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-at-rest-waiting-gate',
      title: 'Workflow · a run parked at a gate',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'at-rest-waiting',
        title: 'Run waiting at a gate',
        kind: 'ready',
        marker: 'Waiting at the',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Replayed transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-closed-complete',
      title: 'Workflow · closed after completion',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'closed-complete',
        title: 'Closed completed run',
        kind: 'success',
        marker: 'visual-closed-complete',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Closed run ledger' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-ready-to-apply',
      title: 'Workflow · a reviewed workspace waiting to apply',
      surface: screenSurface('workflow'),
      viewports: WIDE_VIEWPORTS,
      checkpoint: {
        id: 'ready-to-apply',
        title: 'Ready to apply',
        kind: 'ready',
        marker: 'Ready to apply',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Replayed transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-ready-empty-diff',
      title: 'Workflow · Show diff with no changes',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'ready-empty-diff',
        title: 'No changes to show',
        kind: 'ready',
        marker: 'No run changes to show.',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Replayed transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-external-editor',
      title: 'Workflow · run diff open in an external editor',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'external-editor',
        title: 'Waiting for the editor to close',
        kind: 'ready',
        marker: 'Close the file to return.',
      },
      elements: [{ id: 'activity', title: 'External editor return instruction' }],
    }),
    defineScenario({
      id: 'workflow-external-editor-macos',
      title: 'Workflow · run diff open in the macOS text editor',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'external-editor-macos',
        title: 'Waiting for the editor app to quit',
        kind: 'ready',
        marker: 'Quit the editor app to return.',
      },
      elements: [{ id: 'activity', title: 'External editor return instruction' }],
    }),
    defineScenario({
      id: 'workflow-ready-override',
      title: 'Workflow · a reviewed workspace accepted as is',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'ready-override',
        title: 'Ready to apply as is',
        kind: 'ready',
        marker: 'Ready to apply as is',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Replayed transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-closed-applied',
      title: 'Workflow · applied to the checkout',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'closed-applied',
        title: 'Applied run',
        kind: 'success',
        marker: 'visual-closed-applied',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Closed run ledger' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-closed-undone',
      title: 'Workflow · Apply undone',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'closed-undone',
        title: 'Apply undone',
        kind: 'success',
        marker: 'visual-closed-undone',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Closed run ledger' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-closed-undo-conflicts',
      title: 'Workflow · Apply undone with later edits kept',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'closed-undo-conflicts',
        title: 'Undo conflicts kept',
        kind: 'success',
        marker: 'visual-closed-undo-conflicts',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Closed run ledger' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-closed-discarded',
      title: 'Workflow · discarded with its changes in run.patch',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'closed-discarded',
        title: 'Discarded run',
        kind: 'failure',
        marker: 'visual-closed-discarded',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Closed run ledger' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-closed-complete-needs-attention',
      title: 'Workflow · closed and needing attention',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'closed-needs-attention',
        title: 'Closed run needing attention',
        kind: 'success',
        marker: 'visual-closed-needs-attention',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Closed run ledger' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-closed-ended',
      title: 'Workflow · ended by the user',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'closed-ended',
        title: 'Ended run',
        kind: 'failure',
        marker: 'visual-closed-ended',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Closed run ledger' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-closed-ended-empty',
      title: 'Workflow · ended without changes',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'closed-ended-empty',
        title: 'Ended run without a patch',
        kind: 'failure',
        marker: 'visual-closed-ended-empty',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Closed run ledger' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-closed-ended-workspace',
      title: 'Workflow · a worktree run ended inside a brief',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'closed-ended-workspace',
        title: 'Ended mid-brief with its changes in run.patch',
        kind: 'failure',
        marker: 'visual-closed-ended-workspace',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Stop notices and closed run ledger' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-closed-queued',
      title: 'Workflow · ended with a pending BUILD message',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'closed-ended',
        title: 'Ended run with pending-message history',
        kind: 'failure',
        marker: 'visual-closed-queued',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Pending-message history and closed run ledger' },
        { id: 'composer', title: 'Closed run composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-closed-ended-review',
      title: 'Workflow · ended after a failed review',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'closed-ended-review',
        title: 'Ended failed review',
        kind: 'failure',
        marker: 'visual-ended-review',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Closed run ledger' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-closed-ended-review-workspace',
      title: 'Workflow · a worktree run ended after a failed review',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'closed-ended-review-workspace',
        title: 'Ended failed review with its result in run.patch',
        kind: 'failure',
        marker: 'visual-ended-review-workspace',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Closed run ledger' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-closed-seat-moved',
      title: 'Workflow · closed after the build seat moved tools',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'closed-seat-moved',
        title: 'Closed run whose build seat moved',
        kind: 'success',
        marker: 'visual-closed-seat-moved',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Closed run ledger' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-closed-mixed-workers',
      title: 'Workflow · closed after briefs used mixed workers',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'closed-mixed-workers',
        title: 'Closed run with mixed workers',
        kind: 'success',
        marker: 'visual-closed-mixed-workers',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Closed run ledger' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-replayed-history',
      title: 'Workflow · history replayed from the run log',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'replayed',
        title: 'Replayed run history',
        kind: 'ready',
        marker: 'Stopped at',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Replayed transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-gates-approved',
      title: 'Workflow · gates approved, replayed from the run log',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'gates-approved',
        title: 'Replayed run past its approved gates',
        kind: 'ready',
        marker: 'T002',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Replayed transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-gate-stopped',
      title: 'Workflow · stopped at a gate, replayed from the run log',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'gate-stopped',
        title: 'Run stopped while a gate was open',
        kind: 'ready',
        marker: 'Stopped at the plan',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Replayed transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-retained-workspace',
      title: 'Workflow · kept workspace notice',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'retained-workspace',
        title: 'Kept run workspace notice',
        kind: 'failure',
        marker: 'Workspace kept',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Workspace notice' },
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
        marker: 'Change BUILD tool',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'question-panel', title: 'Recovery menu panel' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-recovery-balance-spent',
      title: 'Workflow · a spent balance on BUILD',
      surface: screenSurface('workflow'),
      viewports: [...WIDE_VIEWPORTS, viewport({ cols: 200, rows: 50 })],
      checkpoint: {
        id: 'recovery',
        title: 'Balance recovery menu',
        kind: 'question',
        marker: 'Seat down · Balance spent on OpenCode CLI',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'question-panel', title: 'Recovery menu panel' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    ...[
      {
        id: 'workflow-recovery-no-fallback',
        title: 'Workflow · BUILD halt with no fallback',
        checkpoint: 'recovery-no-fallback',
      },
      {
        id: 'workflow-recovery-fallback-used',
        title: 'Workflow · BUILD fallback already used in this run',
        checkpoint: 'recovery-fallback-used',
      },
      {
        id: 'workflow-recovery-fallback-not-installed',
        title: 'Workflow · BUILD fallback tool is not installed',
        checkpoint: 'recovery-fallback-not-installed',
      },
    ].map((input) =>
      defineScenario({
        id: input.id,
        title: input.title,
        surface: screenSurface('workflow'),
        viewports:
          input.id === 'workflow-recovery-fallback-used' ? WIDE_VIEWPORTS : REQUIRED_VIEWPORTS,
        checkpoint: {
          id: input.checkpoint,
          title: input.title,
          kind: 'question',
          marker: 'Change BUILD tool',
        },
        elements: [
          { id: 'header', title: 'Workflow header' },
          { id: 'question-panel', title: 'Recovery menu panel' },
          { id: 'composer', title: 'Workflow composer' },
        ],
      }),
    ),
    defineScenario({
      id: 'workflow-recovery-plan-seat',
      title: 'Workflow · quota halt on the plan seat',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'recovery-plan',
        title: 'Plan-seat usage-limit recovery menu',
        kind: 'question',
        marker: 'Change PLAN tool',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'question-panel', title: 'Recovery menu panel' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-recovery-plan-checks',
      title: 'Workflow · a plan that still fails its checks after one repair',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'recovery-plan-checks',
        title: 'Plan checks halt recovery menu',
        kind: 'question',
        marker: 'Send a correction',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'question-panel', title: 'Recovery menu panel' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-recovery-plan-questions',
      title: 'Workflow · a planner that still asks questions after two rounds',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'recovery-plan-questions',
        title: 'Plan questions halt recovery menu',
        kind: 'question',
        marker: 'Send a correction',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'question-panel', title: 'Recovery menu panel' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-recovery-review-seat',
      title: 'Workflow · quota halt on the review seat',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'recovery-review',
        title: 'Review-seat usage-limit recovery menu',
        kind: 'question',
        marker: 'Change REVIEW tool',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'question-panel', title: 'Recovery menu panel' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-recovery-hint-seat',
      title: "Workflow · quota halt on a brief's hint",
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'recovery-hint',
        title: 'Hint usage-limit recovery menu',
        kind: 'question',
        marker: 'Change PLAN tool',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'question-panel', title: 'Recovery menu panel' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-recovery-plan-swapped',
      title: 'Workflow · plan seat moved to another tool',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'recovery-plan-swapped',
        title: 'Plan-seat swap in the transcript',
        kind: 'planning',
        marker: 'continued',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Recovery transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-seat-switched',
      title: 'Workflow · BUILD seat moved automatically to its fallback',
      surface: screenSurface('workflow'),
      viewports: WIDE_VIEWPORTS,
      checkpoint: [
        {
          id: 'seat-switched',
          title: 'Seat switch row in the transcript',
          kind: 'implementation',
          marker: 'BUILD  OpenCode CLI',
        },
        {
          id: 'seat-switched-expanded-recovery',
          title: 'Recovery details expanded with ctrl+d',
          kind: 'implementation',
          marker: 'ctrl+d to collapse',
        },
      ],
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Implementation transcript' },
        { id: 'sidebar', title: 'Workflow sidebar' },
      ],
    }),
    defineScenario({
      id: 'workflow-spent-b2-replay',
      title: 'Workflow · historical spent-balance smoke replay',
      surface: screenSurface('workflow'),
      viewports: [viewport({ cols: 200, rows: 50 }), viewport({ cols: 60, rows: 18 })],
      checkpoint: [
        {
          id: 'spent-b2-replay',
          title: 'Both historical briefs completed after the automatic switch',
          kind: 'implementation',
          marker: 'Recovery  Balance spent on OpenCode CLI',
        },
        {
          id: 'spent-b2-replay-t001-activity',
          title: 'T001 activity and disclosure',
          kind: 'implementation',
          marker: 'BUILD activity  5 updates',
        },
        {
          id: 'spent-b2-replay-t001-completion',
          title: 'T001 completion source and test files',
          kind: 'implementation',
          marker: 'src/text.js · test/text.test.js',
        },
        {
          id: 'spent-b2-replay-t002-activity',
          title: 'T002 activity and disclosure',
          kind: 'implementation',
          marker: 'BUILD activity  4 updates',
        },
        {
          id: 'spent-b2-replay-t002-completion',
          title: 'T002 completion source and test files',
          kind: 'implementation',
          marker: 'src/preview.js · test/preview.test.js',
        },
      ],
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Replayed implementation transcript' },
        { id: 'sidebar', title: 'Workflow sidebar' },
      ],
    }),
    defineScenario({
      id: 'workflow-seat-switched-manual',
      title: 'Workflow · BUILD seat changed manually',
      surface: screenSurface('workflow'),
      viewports: WIDE_VIEWPORTS,
      checkpoint: {
        id: 'seat-switched-manual',
        title: 'Manual seat switch row in the transcript',
        kind: 'implementation',
        marker: 'BUILD  OpenCode CLI',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Implementation transcript' },
        { id: 'sidebar', title: 'Workflow sidebar' },
      ],
    }),
    defineScenario({
      id: 'workflow-seat-switched-balance',
      title: 'Workflow · spent balance switches BUILD to the same-name fallback',
      surface: screenSurface('workflow'),
      viewports: WIDE_VIEWPORTS,
      checkpoint: {
        id: 'seat-switched-balance',
        title: 'Automatic balance switch and restarted brief',
        kind: 'implementation',
        marker: 'BUILD  OpenCode CLI',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Implementation transcript' },
        { id: 'sidebar', title: 'Workflow sidebar' },
      ],
    }),
    defineScenario({
      id: 'workflow-plan-activity',
      title: 'Workflow · plan activity beside the seat that ran it',
      surface: screenSurface('workflow'),
      viewports: [...WIDE_VIEWPORTS, viewport({ cols: 220, rows: 45 })],
      checkpoint: {
        id: 'plan-activity',
        title: 'Plan activity batch',
        kind: 'planning',
        marker: 'PLAN activity',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Planning transcript' },
        { id: 'activity', title: 'Plan activity block' },
        { id: 'sidebar', title: 'Workflow sidebar' },
      ],
    }),
    defineScenario({
      id: 'workflow-recovery-retry-exhausted',
      title: 'Workflow · a brief that could not be landed',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'retry-exhausted',
        title: 'Retry-exhausted recovery menu',
        kind: 'question',
        // The headline is the one line the panel keeps at 60x18, where the row budget
        // leaves room for the actions and nothing else.
        marker: 'Needs you · T901 failed',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'question-panel', title: 'Recovery menu panel' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-recovery-consult-bound',
      title: 'Workflow · a brief that used its consult allowance',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'consult-bound',
        title: 'Consult-bound recovery menu',
        kind: 'question',
        // The headline is the one line the panel keeps at 60x18.
        marker: 'Needs you · T901 used its consult allowance',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'question-panel', title: 'Recovery menu panel' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-recovery-consult-bound-note',
      title: 'Workflow · a note typed beside the consult-bound menu',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'consult-bound-note',
        title: 'Consult-bound menu with the composer focused',
        kind: 'question',
        marker: 'Needs you · T901 used its consult allowance',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'question-panel', title: 'Recovery menu panel' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-recovery-review-failed',
      title: 'Workflow · a checkout final review that failed after its repair cycles',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'review-failed',
        title: 'Review-failed recovery menu',
        kind: 'question',
        marker: 'Fix again',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'question-panel', title: 'Recovery menu panel' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-recovery-review-unverified',
      title: 'Workflow · a final review that left criteria unverified',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'review-unverified',
        title: 'Review-unverified recovery menu',
        kind: 'question',
        marker: 'Fix again',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'question-panel', title: 'Recovery menu panel' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-recovery-left-isolation',
      title: 'Workflow · an implementer that left its isolation directory',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'left-isolation',
        title: 'Left-isolation recovery menu',
        kind: 'question',
        marker: 'Seat down · T901 left the isolation directory',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'question-panel', title: 'Recovery menu panel' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-recovery-left-isolation-in-place',
      title: 'Workflow · an implementer that wrote outside your checkout',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'left-isolation',
        title: 'Checkout mode left-isolation recovery menu',
        kind: 'question',
        marker: 'Seat down · T901 left the isolation directory',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'question-panel', title: 'Recovery menu panel' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-recovery-checkout-changed',
      title: 'Workflow · a checkout whose git state changed during an implementer call',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'checkout-changed',
        title: 'Checkout-changed recovery menu',
        kind: 'question',
        marker: 'Needs you · Repository changed under T901',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'question-panel', title: 'Recovery menu panel' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-recovery-resolved-retry',
      title: 'Workflow · a checkout halt resolved with Try again',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'recovery-resolved-retry',
        title: 'Halt and Try again folded above the retry',
        kind: 'implementation',
        marker: 'back to pending',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Implementation transcript' },
      ],
    }),
    // The same halt read back later: the transcript rows the halt wrote and the byline naming it.
    defineScenario({
      id: 'workflow-at-rest-left-isolation',
      title: 'Workflow · a run halted outside its isolation directory, at rest',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'at-rest-left-isolation',
        title: 'Left-isolation halt at rest',
        kind: 'ready',
        marker: 'Seat down',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Replayed transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-api-context-insufficient',
      title: 'Workflow · a packet the plan seat was never given',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'api-context',
        title: 'Insufficient-context recovery menu',
        kind: 'question',
        marker: 'Nothing was sent to PLAN',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'question-panel', title: 'Recovery menu panel' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-review-context-insufficient',
      title: 'Workflow · review context recovery',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'review-context',
        title: 'The review seat needs more context',
        kind: 'question',
        marker: 'Nothing was sent to REVIEW',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'question-panel', title: 'Recovery menu panel' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-review-call-failed',
      title: 'Workflow · review call recovery',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'review-call-failed',
        title: 'A review timeout offers Try again without a seat remedy',
        kind: 'question',
        marker: 'Review call timed out',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'question-panel', title: 'Recovery menu panel' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    // Re-entering a run at rest: the run keeps the screen and its byline row states the check.
    defineScenario({
      id: 'workflow-continuing',
      title: 'Workflow · checking tools to continue a run',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'ready',
        title: 'Check running beside the composer',
        kind: 'ready',
        marker: 'Checking tools',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
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
    defineScenario({
      id: 'workflow-removed-command',
      title: 'Workflow · a removed command points at its replacement',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'ready',
        title: 'Removed command answered',
        kind: 'ready',
        marker: 'was removed',
      },
      elements: [{ id: 'composer', title: 'Workflow composer' }],
    }),
    defineScenario({
      id: 'workflow-planning-claude-frames',
      title: 'Workflow · a Claude Code plan call and its system frames',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'planning-claude-frames',
        title: 'Plan activity after the system frames',
        kind: 'planning',
        marker: 'src/engine/streaming/parse-stream-json.ts',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Planning transcript' },
        { id: 'activity', title: 'Plan activity block' },
      ],
    }),
    defineScenario({
      id: 'workflow-planner-session-expired',
      title: 'Workflow · a planner thread that expired, asked again on a fresh one',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'planner-session-expired',
        title: 'Expired thread asked again on a fresh session',
        kind: 'planning',
        marker: 'Planner session expired',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Planning transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-implementation-silent',
      title: 'Workflow · a silent seat mid-brief, on a stream that reports tools when done',
      surface: screenSurface('workflow'),
      viewports: [...WIDE_VIEWPORTS, viewport({ cols: 220, rows: 45 })],
      checkpoint: {
        id: 'implementation-silent',
        title: 'Silence stated once, in the build block, with the stream hint',
        kind: 'implementation',
        marker: 'tools report when done',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-implementation-tool-running',
      title: 'Workflow · a seat silent while its tool runs',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'implementation-tool-running',
        title: 'The silence names the running tool in the build block',
        kind: 'implementation',
        marker: 'running npx vitest run',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-implementation-shell-wrapper',
      title: 'Workflow · codex shell commands in the activity rows',
      surface: screenSurface('workflow'),
      viewports: REQUIRED_VIEWPORTS,
      checkpoint: {
        id: 'implementation-shell-wrapper',
        title: 'Shell commands in the transcript and build progress',
        kind: 'implementation',
        marker: 'pnpm-lock.yaml',
      },
      elements: [
        { id: 'header', title: 'Workflow header and build progress' },
        { id: 'transcript', title: 'Shell command transcript' },
        { id: 'activity', title: 'Shell command activity block' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-implementation-silent-bare',
      title: 'Workflow · a silent seat with no open tool and no stream hint',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'implementation-silent-bare',
        title: 'The silence alone, in the build block',
        kind: 'implementation',
        marker: 'No output for',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-review-render-running',
      title: 'Workflow · plan renders collected before the review',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'review-render-running',
        title: 'Two settled renders and a third render running for twelve seconds',
        kind: 'review',
        marker: 'Render workflow-review',
      },
      elements: [
        { id: 'header', title: 'Workflow header and build progress' },
        { id: 'transcript', title: 'Passed briefs and plan render checks' },
        { id: 'composer', title: 'Review stage, render scenario and clock' },
      ],
    }),
    // In a real run, the ten-minute pre-review `npm test` read `Implementing… 10:02`.
    defineScenario({
      id: 'workflow-review-check-running',
      title: 'Workflow · a reviewer check ten minutes in',
      surface: screenSurface('workflow'),
      viewports: WIDE_VIEWPORTS,
      checkpoint: {
        id: 'review-check-running',
        title: 'The reviewer check, its command and its clock in the byline and the build block',
        kind: 'review',
        marker: 'Reviewer check V2',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-review-pause-requested',
      title: 'Workflow · pause requested during a reviewer check',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'review-pause-requested',
        title: 'The pause keeps the review stage, command and clock',
        kind: 'review',
        marker: 'Review · Reviewer check V2',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-review-check-long-command',
      title: 'Workflow · a reviewer check with a command longer than the byline',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'review-check-long-command',
        title: 'The label and the clock survive; only the command is cut',
        kind: 'review',
        marker: 'Reviewer check V2',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-review-checks-approve',
      title: 'Workflow · the reviewer checks wait for Run all or Skip all',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'review-checks-approve',
        title: 'One card names each chosen command and its reason above the composer',
        kind: 'review',
        marker: 'Skip all',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-review-checks-skipped',
      title: 'Workflow · the user skipped the reviewer checks',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'review-checks-skipped',
        title: 'One row names every command that did not run and why',
        kind: 'review',
        marker: 'not\u00a0run V1, V2',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Review transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-review-legacy-suite',
      title: 'Workflow · a session from before reviewer checks replays its full-suite stages',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'review-legacy-suite',
        title: 'Full-suite rows with no check id keep their own words',
        kind: 'review',
        marker: 'Pre-review suite',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Full-suite transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-review-red-gate',
      title: 'Workflow · the reviewer answers a red reviewer check',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'review-red-gate',
        title: 'A refused, a red and a skipped check, then the reviewer activity and byline',
        kind: 'review',
        marker: 'REVIEW activity',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Reviewer checks and reviewer activity' },
        { id: 'composer', title: 'Reviewer identity' },
      ],
    }),
    defineScenario({
      id: 'workflow-review-base-rerun',
      title: 'Workflow · a review failure re-runs at the run base',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'review-base-rerun',
        title: 'The base command in the byline, build block and transcript',
        kind: 'review',
        marker: 'Base re-run',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Reviewer checks transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-review-base-mixed',
      title: 'Workflow · a red with new and pre-existing failures stops the reviewer checks',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'review-base-mixed',
        title: 'The base row counts the new and the pre-existing failures',
        kind: 'review',
        marker: 'pre-existing',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Reviewer checks transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-review-base-not-verified',
      title: 'Workflow · a red base re-run not verified at the run base',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'review-base-not-verified',
        title: 'The base re-run row counts the failure not verified at the run base and says why',
        kind: 'review',
        marker: 'Base re-run V1',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Reviewer checks transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-review-base-rejected',
      title: 'Workflow · the reviewer rejects a red check not verified at the run base',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'review-base-rejected',
        title: 'The base re-run row quotes the error line and the review passes with its note',
        kind: 'review',
        marker: 'Base re-run V1',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Reviewer checks transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-fix-check-running',
      title: 'Workflow · a fix brief runs the red reviewer check again',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'fix-check-running',
        title: 'The fix check, its command and its clock in the transcript and the build block',
        kind: 'implementation',
        marker: 'Fix check V2',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Fix brief transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-fix-check-done',
      title: 'Workflow · a fix check shows which carried failures remain',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'fix-check-done',
        title: 'A fix check with a carried failure left, the retry, then all carried failures gone',
        kind: 'implementation',
        marker: 'your 2 failures gone',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Fix brief transcript' },
        { id: 'composer', title: 'Workflow composer' },
      ],
    }),
    defineScenario({
      id: 'workflow-fix-check-stopped-continued',
      title: 'Workflow · a stopped fix check after continuation',
      surface: screenSurface('workflow'),
      checkpoint: {
        id: 'fix-check-stopped-continued',
        title: 'The interrupted check stays stopped while the implementer retries the brief',
        kind: 'implementation',
        marker: 'Fix check V2 · npm test · stopped',
      },
      elements: [
        { id: 'header', title: 'Workflow header' },
        { id: 'transcript', title: 'Stopped check and brief retry' },
        { id: 'composer', title: 'Continued build status' },
      ],
    }),
  ],
  setup: [
    defineScenario({
      id: 'setup-no-config-detecting',
      title: 'Setup · first tool check',
      surface: screenSurface('setup'),
      checkpoint: {
        id: 'ready',
        title: 'Finding ready tools',
        kind: 'ready',
        marker: 'Choose your crew after the tool check.',
      },
      elements: [
        { id: 'header', title: 'Setup header' },
        { id: 'setup-panel', title: 'Setup panel' },
      ],
    }),
    defineScenario({
      id: 'setup-no-config-cached-refresh',
      title: 'Setup · remembered tools before first save',
      surface: screenSurface('setup'),
      checkpoint: {
        id: 'ready',
        title: 'Waiting for a fresh crew proposal',
        kind: 'ready',
        marker: 'Choose your crew after the tool check.',
      },
      elements: [
        { id: 'header', title: 'Setup header' },
        { id: 'setup-panel', title: 'Setup panel' },
      ],
    }),
    defineScenario({
      id: 'setup-no-config-cached-failure',
      title: 'Setup · remembered tools after a failed refresh',
      surface: screenSurface('setup'),
      checkpoint: {
        id: 'ready',
        title: 'Retry without saving an unavailable crew',
        kind: 'ready',
        marker: 'Tool check failed',
      },
      elements: [
        { id: 'header', title: 'Setup header' },
        { id: 'setup-panel', title: 'Setup panel' },
      ],
    }),
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
    defineScenario({
      id: 'setup-unavailable-seat',
      title: 'Setup · unavailable build seat',
      surface: screenSurface('setup'),
      checkpoint: {
        id: 'ready',
        title: 'Unavailable seat shown',
        kind: 'ready',
        marker: 'Unavailable',
      },
      elements: [
        { id: 'header', title: 'Setup header' },
        { id: 'setup-panel', title: 'Setup panel' },
      ],
    }),
    defineScenario({
      id: 'setup-api-endpoint-override',
      title: 'Setup · ready endpoint override',
      surface: screenSurface('setup'),
      checkpoint: {
        id: 'ready',
        title: 'Ready invocation and persisted crew',
        kind: 'ready',
        marker: 'Custom Coder',
      },
      elements: [
        { id: 'header', title: 'Setup header' },
        { id: 'setup-panel', title: 'Setup panel' },
      ],
    }),
    defineScenario({
      id: 'setup-persisted-api-unavailable',
      title: 'Setup · unavailable persisted endpoint',
      surface: screenSurface('setup'),
      checkpoint: {
        id: 'ready',
        title: 'An override cannot authorize an unavailable saved endpoint',
        kind: 'ready',
        marker: 'Unavailable',
      },
      elements: [
        { id: 'header', title: 'Setup header' },
        { id: 'setup-panel', title: 'Setup panel' },
      ],
    }),
    defineScenario({
      id: 'setup-custom-api',
      title: 'Setup · ready custom API connection',
      surface: screenSurface('setup'),
      checkpoint: {
        id: 'ready',
        title: 'Custom API crew ready',
        kind: 'ready',
        marker: 'Custom Coder',
      },
      elements: [
        { id: 'header', title: 'Setup header' },
        { id: 'setup-panel', title: 'Setup panel' },
      ],
    }),
    defineScenario({
      id: 'setup-custom-api-unavailable',
      title: 'Setup · custom API missing the selected model',
      surface: screenSurface('setup'),
      checkpoint: {
        id: 'ready',
        title: 'Missing custom model blocks Continue',
        kind: 'ready',
        marker: 'Unavailable',
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
  readonly viewports?: readonly Viewport[];
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
      viewports: scenario.viewports,
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
    scenarios: [
      {
        id: 'overlay-skills',
        title: 'Overlay · skills · no skills found',
        marker: 'No skills found',
      },
      { id: 'overlay-skills-list', title: 'Overlay · skills', marker: 'Skills' },
    ],
  }),
  settings: overlayGroup({
    overlay: 'settings',
    underlyingScreen: 'home',
    panelTitle: 'Settings panel',
    checkpointTitle: 'Settings ready',
    scenarios: [
      { id: 'overlay-settings', title: 'Overlay · settings', marker: 'Settings' },
      {
        id: 'overlay-settings-opencode-routes',
        title: 'Overlay · settings · same model on different OpenCode routes',
        marker: 'Fallback',
      },
      {
        id: 'overlay-settings-crew-full',
        title: 'Overlay · settings · full crew',
        marker: 'Settings',
      },
      {
        id: 'overlay-settings-fallback-none',
        title: 'Overlay · settings · no fallbacks',
        marker: 'Fallback',
      },
      {
        id: 'overlay-settings-fallback-set',
        title: 'Overlay · settings · configured fallbacks',
        marker: 'Fallback',
      },
      {
        id: 'overlay-settings-fallback-filtered',
        title: 'Overlay · settings · filtered to fallback',
        marker: 'fallback',
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
        id: 'overlay-settings-claude-alias',
        title: 'Overlay · settings · Claude alias plan seat',
        marker: 'Settings',
      },
      {
        id: 'overlay-settings-crew-api-twin',
        title: 'Overlay · settings · API build seat named after a CLI tool',
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
        id: 'overlay-settings-filter-approval',
        title: 'Overlay · settings · filtered to plan approval',
        marker: 'Settings',
      },
      {
        id: 'overlay-settings-filter-workflow',
        title: 'Overlay · settings · filtered to the workflow section',
        marker: 'Settings',
      },
      {
        id: 'overlay-settings-end-checks',
        title: 'Overlay · settings · the End-of-run checks toggle',
        marker: 'End-of-run checks',
      },
      {
        id: 'overlay-settings-end-checks-off',
        title: 'Overlay · settings · End-of-run checks turned off',
        marker: 'End-of-run checks',
      },
      {
        id: 'overlay-settings-approve-checks-ask',
        title: 'Overlay · settings · the reviewer checks wait for your Run all or Skip all',
        marker: 'Approve checks',
      },
      {
        id: 'overlay-settings-isolation-checkout',
        title: 'Overlay · settings · build seat working in your checkout',
        marker: 'Settings',
      },
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
        id: 'overlay-picker-claude-effort-returned',
        title: 'Overlay · planner picker · Claude alias effort after the cursor returns',
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
        id: 'overlay-planner-picker-first-discovery',
        title: 'Overlay · planner picker · first tool check',
        marker: BOOT_MANIFEST_TITLE,
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
        id: 'overlay-planner-picker-command-failed',
        title: 'Overlay · planner picker · model listing command failed',
        marker: PICKER_TITLE_MARKER,
      },
      {
        id: 'overlay-planner-picker-command-failed-stale',
        title: 'Overlay · planner picker · failed command with stale models',
        marker: PICKER_TITLE_MARKER,
      },
      {
        id: 'overlay-planner-picker-claude',
        title: 'Overlay · planner picker · Claude Code alias rows',
        marker: PICKER_TITLE_MARKER,
      },
      {
        id: 'overlay-planner-picker-claude-custom-twin',
        title: 'Overlay · planner picker · custom row holding an alias full id',
        marker: PICKER_TITLE_MARKER,
      },
      {
        id: 'overlay-planner-picker-copilot',
        title: 'Overlay · planner picker · GitHub Copilot models',
        marker: PICKER_TITLE_MARKER,
      },
      {
        id: 'overlay-planner-picker-command-code',
        title: 'Overlay · planner picker · Command Code native rows',
        marker: PICKER_TITLE_MARKER,
      },
      {
        id: 'overlay-planner-picker-codex',
        title: 'Overlay · planner picker · OpenAI Codex models',
        marker: PICKER_TITLE_MARKER,
      },
      {
        id: 'overlay-planner-picker-antigravity',
        title: 'Overlay · planner picker · Antigravity effort axis',
        marker: PICKER_TITLE_MARKER,
      },
      {
        id: 'overlay-planner-picker-antigravity-listed',
        title: 'Overlay · planner picker · Antigravity effort spelled by the model id',
        marker: PICKER_TITLE_MARKER,
      },
      {
        id: 'overlay-picker-opencode-filter',
        title: 'Overlay · planner picker · OpenCode filter on one model family',
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
        id: 'overlay-picker-custom-launcher',
        title: 'Overlay · planner picker · add a custom command',
        marker: PICKER_TITLE_MARKER,
      },
      {
        id: 'overlay-picker-local-server',
        title: 'Overlay · planner picker · a local server that is not running',
        marker: PICKER_TITLE_MARKER,
      },
      ...(
        [
          ['ollama', 'Ollama connection editor', 'Not checked yet'],
          ['offline', 'server offline', 'Ollama is not reachable'],
          ['timeout', 'catalog timeout', 'Ollama did not answer'],
          ['unauthorized', 'token refused', 'LM Studio rejected the token'],
          ['invalid', 'invalid endpoint', 'Ollama does not accept this address'],
          ['unknown', 'unknown failure', 'Ollama did not say what failed'],
          ['malformed', 'unreadable catalog', 'Ollama returned an unreadable catalog'],
          ['empty', 'empty catalog', 'no models installed'],
          ['missing', 'selected model absent', 'does not serve'],
          ['loaded', 'model loaded', 'LM Studio answered'],
          ['not-loaded', 'model not loaded', 'not loaded'],
          ['listed', 'model listed, loading unknown', 'Ollama answered'],
        ] as const
      ).map(([id, title, marker]) => ({
        id: `overlay-local-connection-${id}`,
        title: `Overlay · local connection · ${title}`,
        marker,
      })),
      {
        id: 'overlay-picker-auth-config-owned',
        title: 'Overlay · authentication owned by CLI configuration',
        marker: 'CLI decides',
      },
      {
        id: 'overlay-picker-auth-unsupported',
        title: 'Overlay · configured authentication method without enforcement proof',
        marker: 'unproven',
      },
      {
        id: 'overlay-picker-contract-choice',
        title: 'Overlay · planner picker · custom command contract',
        marker: 'Custom command · PLAN',
      },
      {
        id: 'overlay-picker-custom-command',
        title: 'Overlay · planner picker · custom command entry',
        marker: 'Custom command · PLAN',
      },
      {
        id: 'overlay-picker-custom-model',
        title: 'Overlay · planner picker · custom model entry',
        marker: 'Custom model · PLAN',
      },
      {
        id: 'overlay-picker-custom-model-claude',
        title: 'Overlay · planner picker · custom model entry, Claude Code ids',
        marker: 'Model id for Claude Code',
      },
      {
        id: 'overlay-picker-custom-model-kilo',
        title: 'Overlay · planner picker · custom model entry, Kilo Code ids',
        marker: 'Model id for Kilo Code',
      },
      {
        id: 'overlay-picker-save-refused',
        title: 'Overlay · planner picker · a save the config refused',
        marker: 'Failed to save config',
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
        id: 'overlay-local-connection-lmstudio',
        title: 'Overlay · BUILD · LM Studio connection editor',
        marker: 'Not checked yet',
      },
      {
        id: 'overlay-implementer-picker',
        title: 'Overlay · implementer picker',
        marker: 'Add custom model',
      },
      {
        id: 'overlay-implementer-picker-claude',
        title: 'Overlay · implementer picker · Claude Code build seat',
        marker: PICKER_TITLE_MARKER,
      },
      {
        id: 'overlay-implementer-picker-api-twin',
        title: 'Overlay · implementer picker · API build seat named after a CLI tool',
        marker: PICKER_TITLE_MARKER,
      },
      // The seat swap a quota halt offers opens this picker, on the tool it offered: the halt
      // names a tool, the picker names the model, and there is no third surface between them.
      {
        id: 'overlay-picker-seat-swap',
        title: 'Overlay · implementer picker · the tool a quota halt offered',
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
        id: 'overlay-local-connection-llamacpp',
        title: 'Overlay · REVIEW · llama.cpp connection editor',
        marker: 'Not checked yet',
      },
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
  'planner-fallback-picker': overlayGroup({
    overlay: 'planner-fallback-picker',
    underlyingScreen: 'home',
    panelTitle: 'Planner fallback picker panel',
    checkpointTitle: 'Planner fallback picker ready',
    scenarios: [
      {
        id: 'overlay-fallback-picker-current',
        title: 'Overlay · PLAN fallback · configured effort expanded',
        marker: PICKER_TITLE_MARKER,
      },
    ],
  }),
  'implementer-fallback-picker': overlayGroup({
    overlay: 'implementer-fallback-picker',
    underlyingScreen: 'home',
    panelTitle: 'Implementer fallback picker panel',
    checkpointTitle: 'Implementer fallback picker ready',
    scenarios: [
      {
        id: 'overlay-fallback-picker',
        title: 'Overlay · BUILD fallback · none selected',
        marker: PICKER_TITLE_MARKER,
      },
      {
        id: 'overlay-fallback-picker-variant',
        title: 'Overlay · BUILD fallback · configured variant expanded',
        marker: PICKER_TITLE_MARKER,
      },
      {
        id: 'overlay-fallback-picker-same-seat',
        title: 'Overlay · BUILD fallback · current seat identity refused',
        marker: PICKER_TITLE_MARKER,
      },
    ],
  }),
  'reviewer-fallback-picker': overlayGroup({
    overlay: 'reviewer-fallback-picker',
    underlyingScreen: 'home',
    panelTitle: 'Reviewer fallback picker panel',
    checkpointTitle: 'Reviewer fallback picker ready',
    scenarios: [
      {
        id: 'overlay-fallback-picker-inherited-review',
        title: 'Overlay · REVIEW fallback · inherited from PLAN',
        marker: PICKER_TITLE_MARKER,
      },
      {
        id: 'overlay-fallback-picker-custom-model',
        title: 'Overlay · REVIEW fallback · custom model entry while inheriting PLAN',
        marker: 'Custom fallback model · REVIEW',
      },
    ],
  }),
  'stop-sheet': overlayGroup({
    overlay: 'stop-sheet',
    underlyingScreen: 'workflow',
    panelTitle: 'Stop options panel',
    checkpointTitle: 'Stop sheet ready',
    scenarios: [
      {
        id: 'workflow-stop-sheet',
        title: 'Workflow · stop options',
        marker: 'Stop options',
        viewports: WIDE_VIEWPORTS,
      },
      {
        id: 'workflow-stop-menu-parked-gate',
        title: 'Workflow · parked at the plan gate',
        marker: 'Stopped at the plan',
      },
      {
        id: 'workflow-stop-menu-ended-gate',
        title: 'Workflow · ended at the plan gate',
        marker: 'Ended · esc home',
      },
      {
        id: 'workflow-stop-menu-ended-rewound-gate',
        title: 'Workflow · ended after revising the plan',
        marker: 'Ended · esc home',
        viewports: [...REQUIRED_VIEWPORTS, viewport({ cols: 60, rows: 40 })],
      },
      {
        id: 'workflow-stop-sheet-planning',
        title: 'Workflow · stop options before any brief',
        marker: 'keep the run open',
      },
      {
        id: 'workflow-stop-menu-parked',
        title: 'Workflow · parked options',
        marker: 'Back to sessions',
      },
      {
        id: 'workflow-stop-menu-quit-hint',
        title: 'Workflow · parked options · quit armed',
        marker: 'Press ctrl+c again to quit',
      },
      { id: 'workflow-stop-menu-failed', title: 'Workflow · failed stop', marker: 'Retry stop' },
      {
        id: 'workflow-stop-menu-pause',
        title: 'Workflow · pause option',
        marker: 'finish T002',
        viewports: WIDE_VIEWPORTS,
      },
      {
        id: 'workflow-stop-sheet-fix-inserted',
        title: 'Workflow · pause after an inserted review fix',
        marker: 'finish T006',
        viewports: [...REQUIRED_VIEWPORTS, viewport({ cols: 160, rows: 45 })],
      },
      {
        id: 'workflow-stop-sheet-after-continue',
        title: 'Workflow · stop options right after a continue',
        marker: 'Pause after this brief',
      },
    ],
  }).concat(
    defineScenario({
      id: 'workflow-stop-sheet-recovery',
      title: 'Workflow · stop options at a recovery halt',
      surface: overlaySurface('stop-sheet', 'workflow'),
      checkpoint: {
        id: 'stop-sheet-recovery',
        title: 'Stop sheet ready',
        kind: 'ready',
        marker: 'Stop options',
      },
      elements: [{ id: 'overlay-panel', title: 'Stop options panel' }],
    }),
  ),
  sessions: overlayGroup({
    overlay: 'sessions',
    underlyingScreen: 'home',
    panelTitle: 'Sessions panel',
    checkpointTitle: 'Sessions ready',
    scenarios: [{ id: 'overlay-sessions', title: 'Overlay · sessions', marker: 'Sessions' }],
  }),
  'usage-details': overlayGroup({
    overlay: 'usage-details',
    underlyingScreen: 'workflow',
    panelTitle: 'Usage details panel',
    checkpointTitle: 'Usage details ready',
    scenarios: [
      {
        id: 'overlay-usage-details',
        title: 'Overlay · usage details · priced run',
        marker: 'Usage details',
      },
      {
        id: 'overlay-usage-details-api-twin',
        title: 'Overlay · usage details · an API endpoint named after a CLI tool',
        marker: 'Usage details',
      },
      {
        id: 'overlay-usage-details-legacy',
        title: 'Overlay · usage details · sum recorded before per-request pricing',
        marker: 'Usage details',
      },
      {
        id: 'overlay-usage-context-insufficient',
        title: 'Overlay · usage details · the context a halted review never had',
        marker: 'Usage details',
      },
    ],
  }),
  editor: overlayGroup({
    overlay: 'editor',
    underlyingScreen: 'workflow',
    panelTitle: 'Editor frame',
    checkpointTitle: 'Editor ready',
    scenarios: [
      { id: 'overlay-editor', title: 'Overlay · editor', marker: 'Add greeting helper' },
      {
        id: 'overlay-editor-not-saved',
        title: 'Overlay · editor · a plan that fails its checks is not saved',
        marker: 'Not saved',
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
