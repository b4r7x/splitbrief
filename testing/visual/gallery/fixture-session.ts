import { isAbsolute, relative, resolve } from 'node:path';
import type { AppInteractionDeps, AppProps } from '../../../src/app/root.js';
import type { AppKeyDeps } from '../../../src/app/keys.js';
import type { HomeScreenDeps } from '../../../src/app/screens/home.js';
import type { SetupScreenDeps } from '../../../src/app/screens/setup.js';
import type { PickerEffectDeps } from '../../../src/features/runners/use-picker-actions.js';
import type { SessionSelectDeps } from '../../../src/stores/navigation/session-select.js';
import type { SessionRef } from '../../../src/core/types/session-ref.js';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import type { ProviderCatalogOutcome } from '../../../src/engine/providers/types.js';
import type { PreparedExecution } from '../../../src/engine/runners/prepared-execution.js';
import { createCommandContext } from '../../../src/core/runtime/commands/context-factory.js';
import type {
  RuntimeCommandContext,
  SkillCommandOption,
  SkillToggleResult,
  ToggleSidebarResult,
} from '../../../src/core/runtime/commands/types.js';
import { loadOwnerWorkflowState } from '../../../src/core/state/resume-hydration.js';
import { readRunRecord } from '../../../src/core/sessions/run-record-io.js';
import { getWorkflowSidebarWidth } from '../../../src/features/workflow/layout/rect.js';
import { hydrateRun, readRunHistory } from '../../../src/features/workflow/run-history.js';
import { closeApprovalPrompt } from '../../../src/stores/approval-prompt/prompt.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { configStore } from '../../../src/stores/project/config.js';
import { skillsStore } from '../../../src/stores/project/skills.js';
import { controlsStore } from '../../../src/stores/ui/controls.js';
import { feedbackStore } from '../../../src/stores/ui/feedback.js';
import { overlayStore } from '../../../src/stores/ui/overlay.js';
import { projectFilesStore } from '../../../src/stores/ui/project-files.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import { detachImage, listAttachments } from '../../../src/stores/workflow/attachments.js';
import { lifecycleStore } from '../../../src/stores/workflow/lifecycle.js';
import { tasksStore } from '../../../src/stores/workflow/tasks.js';
import { prepareWorkflowExecution } from '../../helpers/workflow-screen.js';
import {
  CheckpointDefinitionSchema,
  ScenarioDefinitionSchema,
  type CheckpointDefinition,
  type ScenarioDefinition,
} from '../contracts/catalog.js';
import { ViewportSchema, type Viewport } from '../contracts/geometry.js';
import {
  PREVIEW_UNAVAILABLE,
  type FixtureLifecycle,
  type FixtureWrite,
} from '../fixtures/common.js';
import { overlayFixtureRegistry } from '../fixtures/overlay-fixtures.js';
import { screenFixtureRegistry, VISUAL_FIXTURE_PROJECT_DIR } from '../fixtures/screen-fixtures.js';
import { createWorkflowFixtureAppDeps } from '../fixtures/workflow/setup.js';
import { workflowFixtureProjections } from '../fixtures/workflow/projections.js';
import { workflowFixtureRegistry } from '../fixtures/workflow/registry.js';

/** The one directory a previewed App may read or write; every fixture port checks against it. */
export const FIXTURE_SESSION_ROOT = resolve(VISUAL_FIXTURE_PROJECT_DIR);

const PREVIEW_SESSION_ID = 'preview-run';

/** Below this width the screens lay out for a small terminal; the store carries the answer. */
const SMALL_VIEWPORT_COLS = 120;

/** The catalog Check and Retry answer with: it lists, and contacts nothing. */
const PREVIEW_CATALOG: ProviderCatalogOutcome = {
  kind: 'success',
  source: 'provider-runtime',
  provider: 'ollama',
  isLocal: true,
  credential: 'not-required',
  catalog: 'populated',
  models: [{ id: 'qwen2.5-coder:7b' }, { id: 'gemma3:27b' }],
};

export function isInsideFixtureRoot(target: string): boolean {
  const step = relative(FIXTURE_SESSION_ROOT, resolve(target));
  return step === '' || (!step.startsWith('..') && !isAbsolute(step));
}

/** Every path a fixture port hands to a real helper passes through here first. */
function inFixtureRoot<Ref extends { projectDir: string }>(ref: Ref): Ref {
  if (!isInsideFixtureRoot(ref.projectDir)) {
    throw new Error(`Preview reached outside its fixture root: ${ref.projectDir}`);
  }
  return ref;
}

function sayUnavailable(): void {
  feedbackStore.setMessage(PREVIEW_UNAVAILABLE);
}

function unavailableInPreview(): never {
  throw new Error(PREVIEW_UNAVAILABLE);
}

const unavailable = { status: 'unavailable', message: PREVIEW_UNAVAILABLE } as const;

/** The ready state a simulated start lands on; no runner is probed and no machine is checked. */
function preparePreviewRun(
  ref: SessionRef,
  feature: string,
  resumeState?: WorkflowState | undefined,
): PreparedExecution {
  const config = configStore.get().config;
  if (config === null) throw new Error('Preview fixture has no project config');
  return prepareWorkflowExecution({
    projectDir: inFixtureRoot(ref).projectDir,
    feature,
    config,
    sessionId: ref.sessionId,
    ...(resumeState !== undefined && { resumeState }),
  });
}

const previewPrepareExecution: HomeScreenDeps['prepareExecution'] = async (input) => {
  const ref = input.existingSession ?? {
    projectDir: input.projectDir ?? FIXTURE_SESSION_ROOT,
    sessionId: PREVIEW_SESSION_ID,
  };
  return { kind: 'prepared', execution: preparePreviewRun(ref, input.feature, input.resumeState) };
};

/**
 * Home and the sessions overlay open runs through this one object: every read is the real
 * replay pinned to the fixture root, and the preparation behind a continuation is the ready
 * fixture state rather than a check of the machine.
 */
const previewSessionSelect: SessionSelectDeps = {
  loadResumeState: (ref) => loadOwnerWorkflowState(inFixtureRoot(ref)),
  prepareResume: async ({ ref, state }) => ({
    kind: 'prepared',
    execution: preparePreviewRun(ref, state.feature, state),
  }),
  hydrateRun: (record) => {
    inFixtureRoot(record.ref);
    return hydrateRun(record);
  },
  readRunHistory: (record) => {
    inFixtureRoot(record.ref);
    return readRunHistory(record);
  },
  cancelPendingApproval: closeApprovalPrompt,
};

const previewKeys: AppKeyDeps = {
  requestQuit: sayUnavailable,
  requestStopNow: () => {
    sayUnavailable();
    return true;
  },
  refreshSkills: async () => sayUnavailable(),
};

const previewPicker: PickerEffectDeps = {
  refresh: async () => sayUnavailable(),
  checkConnection: async (input) => ({ ...PREVIEW_CATALOG, provider: input.provider }),
  saveConfig: async (config) => {
    configStore.__testReset({ ...configStore.get(), config, diskConfig: config });
    return {
      kind: 'saved',
      ok: true,
      revision: {
        rawSha256: 'preview-fixture-revision',
        fileIdentity: { dev: 0n, ino: 0n, size: 0n, mtimeNs: 0n },
      },
    };
  },
};

const previewSetup: SetupScreenDeps = {
  prepareExecution: previewPrepareExecution,
  readRunRecord: (ref) => readRunRecord(inFixtureRoot(ref)),
  refreshPickerDetection: async () => sayUnavailable(),
};

const previewHome: HomeScreenDeps = {
  prepareExecution: previewPrepareExecution,
  sessionSelect: previewSessionSelect,
};

function previewProjectDir(): string {
  const route = routerStore.get();
  return route.screen === 'workflow' ? route.run.ref.projectDir : configStore.get().projectDir;
}

// Project skills first, then the ones already selected — the order the completion menu paints,
// so a preview lists `/skills` exactly as the production context does.
function listPreviewSkills(): readonly SkillCommandOption[] {
  const { available, selected } = skillsStore.get();
  const project = available.filter((skill) => skill.scope === 'project');
  const globals = available.filter((skill) => skill.scope === 'global');
  return [
    ...project,
    ...globals.filter((skill) => selected.has(skill.id)),
    ...globals.filter((skill) => !selected.has(skill.id)),
  ].map(({ id, name, description }) => ({
    id,
    name,
    description,
    attached: selected.has(id),
  }));
}

function togglePreviewSkill(id: string): SkillToggleResult {
  const { available, selected } = skillsStore.get();
  const skill = available.find((candidate) => candidate.id === id);
  if (skill === undefined) return { status: 'unknown' };
  const wasSelected = selected.has(id);
  skillsStore.toggleSelected(id);
  return { status: wasSelected ? 'deselected' : 'selected', name: skill.name };
}

// The layout owns the breakpoint and a closed run owns its whole width, so the preview answers
// both the way the production context does — minus the preference it would write to disk.
function togglePreviewSidebar(): ToggleSidebarResult {
  const { cols } = terminalSizeStore.get();
  if (getWorkflowSidebarWidth({ cols, sidebarVisible: true }) === 0) {
    return { status: 'unavailable', message: 'Sidebar is hidden on small terminals.' };
  }
  const route = routerStore.get();
  if (
    route.screen === 'workflow' &&
    route.execution.kind === 'at-rest' &&
    route.run.status.kind === 'closed'
  ) {
    return { status: 'unavailable', message: 'A closed run has no sidebar.' };
  }
  controlsStore.toggleSidebar();
  return { status: 'toggled', visible: controlsStore.get().sidebarVisible };
}

/**
 * Every option spelled out: the reads are the stores the screens already paint from, and every
 * effect is a fixture. Nothing here falls back to a production function.
 */
function createPreviewCommandContext(): RuntimeCommandContext {
  return createCommandContext({
    projectDir: previewProjectDir,
    getSessionId: () => {
      const route = routerStore.get();
      return route.screen === 'workflow' ? route.run.ref.sessionId : null;
    },
    noActiveSession: (command) => new Error(`No active session for ${command}`),
    openOverlay: overlayStore.open,
    navigateHome: () => routerStore.navigate({ to: 'home' }),
    quit: sayUnavailable,
    setFeedbackMessage: feedbackStore.setMessage,
    setFeedbackError: feedbackStore.setError,
    refreshDetection: unavailableInPreview,
    refreshProjectFiles: projectFilesStore.requestRefresh,
    listSkills: listPreviewSkills,
    toggleSkill: togglePreviewSkill,
    refreshSkills: previewKeys.refreshSkills,
    getCurrentPhase: () => lifecycleStore.get().phase,
    requestTaskRedo: () => false,
    resumeRun: () => false,
    endRun: () => false,
    getQueueDepth: () => lifecycleStore.get().queueDepth,
    clearQueue: () => unavailable,
    attachImage: unavailableInPreview,
    plannerSupportsImages: () => false,
    detachImage,
    listAttachments,
    acceptRunSnapshot: unavailableInPreview,
    rejectRunSnapshot: unavailableInPreview,
    refreshRun: () => {
      const route = routerStore.get();
      if (route.screen !== 'workflow') return;
      routerStore.updateRun({ run: readRunRecord(inFixtureRoot(route.run.ref)) });
    },
    // The transcript scrolls and expands under the keys and the mouse the preview passes
    // straight through; the commands that name the same moves would only duplicate the
    // production context's arithmetic, so they say so instead.
    scrollConversation: () => unavailable,
    toggleLatestActivityBatch: () => unavailable,
    toggleLatestDiff: () => unavailable,
    listBriefs: () => tasksStore.get().tasks.map(({ id, status }) => ({ id, status })),
    toggleSidebar: togglePreviewSidebar,
    copyTarget: unavailableInPreview,
  });
}

/** The whole interaction object, with every host effect supplied by the preview. */
export const previewInteractionDeps: AppInteractionDeps = {
  home: previewHome,
  setup: previewSetup,
  runtimeContext: createPreviewCommandContext,
  keys: previewKeys,
  picker: previewPicker,
  readClipboardImage: async () => ({ ok: false, reason: 'unavailable' }),
  listProjectFiles: async () => [],
};

export interface FixtureSessionInput {
  readonly scenario: ScenarioDefinition;
  readonly checkpoint?: CheckpointDefinition | undefined;
  readonly viewport: Viewport;
}

export interface FixtureSession {
  readonly scenario: ScenarioDefinition;
  readonly checkpoint: CheckpointDefinition;
  readonly props: AppProps;
  /** Runs fixture input once, after the App has mounted its input handlers. */
  readonly activate: (write: FixtureWrite) => Promise<void>;
  /** Publishes a new terminal size to the store every screen sizes from. */
  readonly resize: (viewport: Viewport) => Viewport;
  /** Idempotent: the fixture is torn down once and the prior stores are put back once. */
  readonly dispose: () => Promise<void>;
}

/**
 * One scenario, set up and taken down. Capture keeps its own deterministic environment and its
 * own renderer; this is only the lifecycle it shares with a live preview, so a preview freezes
 * no clock and duplicates no catalog entry.
 */
export async function createFixtureSession(input: FixtureSessionInput): Promise<FixtureSession> {
  const scenario = ScenarioDefinitionSchema.parse(input.scenario);
  const checkpoint = resolveCheckpoint(scenario, input.checkpoint);
  const viewport = ViewportSchema.parse(input.viewport);
  assertSupportedViewport(scenario, viewport);

  const fixture = resolveFixtureFactory(scenario)();
  const restoreStores = captureStores();
  try {
    await fixture.setup({ scenario, checkpoint, viewport });
  } catch (error) {
    return teardownAfterFailure(fixture, restoreStores, error);
  }

  const resize = (next: Viewport): Viewport => {
    const parsed = ViewportSchema.parse(next);
    terminalSizeStore.__testReset({
      cols: parsed.cols,
      rows: parsed.rows,
      isSmall: parsed.cols < SMALL_VIEWPORT_COLS,
    });
    return parsed;
  };
  resize(viewport);

  let disposal: Promise<void> | undefined;
  let activation: Promise<void> | undefined;
  const connectionOutcome = fixture.connectionOutcome;
  return {
    scenario,
    checkpoint,
    props: {
      workflowDeps: createWorkflowFixtureAppDeps(
        workflowFixtureProjections.get(scenario.id),
        previewSessionSelect,
      ),
      interactionDeps:
        connectionOutcome === undefined
          ? previewInteractionDeps
          : {
              ...previewInteractionDeps,
              picker: {
                ...previewPicker,
                checkConnection: async (input) =>
                  input.provider === connectionOutcome.provider
                    ? connectionOutcome
                    : previewPicker.checkConnection(input),
              },
            },
    },
    activate: (write) => {
      activation ??= Promise.resolve().then(() => {
        if (disposal === undefined) return fixture.afterMount?.(write);
      });
      return activation;
    },
    resize,
    dispose: () => {
      disposal ??= disposeOnce(fixture, restoreStores);
      return disposal;
    },
  };
}

async function disposeOnce(fixture: FixtureLifecycle, restoreStores: () => void): Promise<void> {
  try {
    await fixture.teardown();
  } finally {
    restoreStores();
  }
}

async function teardownAfterFailure(
  fixture: FixtureLifecycle,
  restoreStores: () => void,
  error: unknown,
): Promise<never> {
  try {
    await fixture.teardown();
  } catch (cleanupError) {
    restoreStores();
    throw new AggregateError([error, cleanupError], 'Fixture session setup and cleanup failed');
  }
  restoreStores();
  throw error;
}

/**
 * What the process was before the fixture took the stores over: the project it was pointed at,
 * the route it was on and the size it measured. Disposal puts all three back rather than leaving
 * the host inside the fixture project.
 */
function captureStores(): () => void {
  const config = configStore.get();
  const route = routerStore.get();
  const terminal = terminalSizeStore.get();
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    configStore.__testReset(config);
    routerStore.init(route);
    terminalSizeStore.__testReset(terminal);
  };
}

function resolveFixtureFactory(scenario: ScenarioDefinition) {
  const factory =
    workflowFixtureRegistry.get(scenario.id) ??
    screenFixtureRegistry.get(scenario.id) ??
    overlayFixtureRegistry.get(scenario.id);
  if (factory === undefined) throw new Error(`No visual fixture registered for ${scenario.id}`);
  return factory;
}

function resolveCheckpoint(
  scenario: ScenarioDefinition,
  requested: CheckpointDefinition | undefined,
): CheckpointDefinition {
  const first = scenario.checkpoints[0];
  if (requested === undefined) {
    if (first === undefined) throw new Error(`Scenario ${scenario.id} declares no checkpoint`);
    return first;
  }
  const parsed = CheckpointDefinitionSchema.parse(requested);
  const checkpoint = scenario.checkpoints.find((candidate) => candidate.id === parsed.id);
  if (
    checkpoint === undefined ||
    checkpoint.kind !== parsed.kind ||
    checkpoint.marker !== parsed.marker ||
    checkpoint.timeoutMs !== parsed.timeoutMs
  ) {
    throw new Error(`Checkpoint ${parsed.id} does not belong to scenario ${scenario.id}`);
  }
  return checkpoint;
}

function assertSupportedViewport(scenario: ScenarioDefinition, viewport: Viewport): void {
  const isSupported = scenario.viewports.some(
    (candidate) => candidate.cols === viewport.cols && candidate.rows === viewport.rows,
  );
  if (!isSupported) {
    throw new Error(
      `Viewport ${viewport.cols}x${viewport.rows} is not supported by ${scenario.id}`,
    );
  }
}
