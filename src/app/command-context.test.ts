import { Box } from 'ink';
import { createElement } from 'react';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import {
  installClipboardExecFixture,
  readClipboardExecCalls,
  resetClipboardExecFixture,
  restoreClipboardExecFixture,
} from '#testing/helpers/clipboard-exec-fixture.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeBriefBoundaryEvents } from '#testing/helpers/events/task.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores, seedBriefs } from '#testing/helpers/stores.js';
import { routerStore } from '../stores/navigation/router.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { EngineEventOf } from '../engine/events/types.js';
import type { AcceptRunResult } from '../core/runtime/commands/types.js';
import type { ApprovalReviewResult } from '../core/approval/types.js';
import type { Phase } from '../core/schemas/enums.js';
import type { WorkflowState } from '../core/schemas/workflow/state.js';
import { STATE_FILE, sessionDir } from '../core/paths.js';
import {
  activeApply,
  trackActiveApply,
} from '../engine/orchestrator/session-lifecycle/shutdown.js';
import { departureStore } from '../stores/workflow/departure.js';
import { overlayStore } from '../stores/ui/overlay.js';
import {
  setClearQueueHandler,
  clearAllHandlers,
  requestClearQueue,
  setResumeHandler,
} from '../features/workflow/run-requests/registry.js';
import { executeRuntimeCommand } from '../core/runtime/commands/dispatch.js';
import { workflowCommands } from '../core/runtime/commands/defs/workflow.js';
import { activityBatchKey } from '../features/workflow/conversation-rows/activity/batch-key.js';
import { readConversationRowActions } from '../features/workflow/conversation-rows/row-actions/read.js';
import { readConversationScrollSnapshot } from '../features/workflow/layout/snapshot.js';
import { buildPromptCallbacks } from '../features/workflow/run-loop/prompt-callbacks.js';
import { plainAnswer, type QuestionAnswer } from '../features/workflow/hooks/use-input-mode.js';
import { configStore } from '../stores/project/config.js';
import { composerDraftStore } from '../stores/ui/composer-draft.js';
import { composerLiveStore } from '../stores/ui/composer-live.js';
import { inputHistoryStore } from '../stores/ui/input-history.js';
import { WorkflowFooter } from '../features/workflow/components/chrome.js';
import { Composer } from '../components/composer/view.js';
import { createDraftDocument } from '../core/composer/document.js';
import { attachmentsStore } from '../stores/workflow/attachments.js';
import { skillsStore } from '../stores/project/skills.js';
import type { SkillMeta } from '../core/skills/types.js';
import { addEvent } from '../stores/workflow/actions/event.js';
import { conversationScrollStore } from '../stores/workflow/conversation-scroll.js';
import { lifecycleStore } from '../stores/workflow/lifecycle/state.js';
import { runViewStore } from '../stores/workflow/run-view.js';
import { queueCopy } from '../features/workflow/queue-copy.js';
import { controlsStore } from '../stores/ui/controls.js';
import { feedbackStore } from '../stores/ui/feedback.js';
import { questionPromptStore } from '../stores/prompts/question.js';
import { terminalSizeStore } from '../stores/ui/terminal-size.js';
import { makeRunnerCallActivity } from '#testing/helpers/events/runner-call.js';
import { makeImplementerGenerate } from '#testing/helpers/events/implementer.js';
import { ConversationFlow } from '../features/workflow/components/conversation-flow/flow.js';
import {
  buildCommandContext,
  useRuntimeCommands,
  type WorkflowCommandPorts,
} from './command-context.js';
import { detectionStore } from '../stores/discovery/detection.js';
import { getDefaultDetectionService } from '../engine/detection/service/create.js';
import type { DetectionDeps } from '../engine/detection/service/types.js';
import * as clipboard from '../lib/clipboard/copy.js';

let projectDir = '';
const originalPlatform = process.platform;

const workflowPorts: WorkflowCommandPorts = {
  requestClearQueue,
  getRowActions: readConversationRowActions,
  readScrollMetrics: readConversationScrollSnapshot,
  resolveCopyValue: (target) => (target === 'message' ? 'port-value' : null),
};

function build() {
  return buildCommandContext({ exit: () => {}, workflow: workflowPorts });
}

afterEach(() => {
  clearAllHandlers();
  resetAllStores();
  restoreClipboardExecFixture();
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  if (projectDir) cleanupTempDir(projectDir);
  projectDir = '';
});

beforeEach(() => {
  installClipboardExecFixture();
  resetClipboardExecFixture();
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
});

function activity(
  overrides: Partial<EngineEventOf<'runner_call_activity'>>,
): EngineEventOf<'runner_call_activity'> {
  return makeRunnerCallActivity('planner-read', overrides);
}

function seedExpandableActivityBatch(): string {
  addEvent(activity({ sequence: 1, activityId: 'a', label: 'reading a.ts' }));
  addEvent(activity({ sequence: 2, activityId: 'b', label: 'reading b.ts' }));
  addEvent(activity({ sequence: 3, activityId: 'c', label: 'reading c.ts' }));
  addEvent(activity({ sequence: 4, activityId: 'd', label: 'reading d.ts' }));
  return activityBatchKey(0, 'call-1');
}

describe('buildCommandContext', () => {
  it('prepares a steer argument once and passes the full message to the continuation', () => {
    projectDir = createTempDir('command-steer');
    const path = `${projectDir}/context.txt`;
    writeFileSync(path, 'context body');
    configStore.__testReset({ projectDir, config: makeConfig() });
    const resume = vi.fn();
    setResumeHandler(resume);

    expect(build().steerRun(`use @${path}`)).toBeUndefined();
    expect(resume).toHaveBeenCalledExactlyOnceWith({
      text: `use @${path}\n\n--- @${path} ---\ncontext body`,
      displayText: `use @${path}`,
      images: [],
      attachedInputs: [{ kind: 'text', path: realpathSync(path) }],
    });
  });

  it('keeps the canonical refusal when a steer file cannot be prepared', async () => {
    const resume = vi.fn();
    setResumeHandler(resume);
    const pending = {
      id: 'pending',
      kind: 'image' as const,
      path: '/outside/a.png',
      mimeType: 'image/png',
      sizeBytes: 1,
    };
    attachmentsStore.replacePendingImages([pending]);
    const onError = vi.fn();

    await executeRuntimeCommand(
      workflowCommands(build()),
      '/steer use @/definitely-missing/context.txt',
      {
        screen: 'workflow',
        phase: 'implementing',
        plannerSupportsImages: false,
        openRunAtRest: false,
        applyUnfinished: false,
        applying: false,
        onError,
      },
    );

    expect(onError.mock.calls).toEqual([
      [
        'Cannot send: file not found. Check the path and try again. File: context.txt.',
        '/steer use @/definitely-missing/context.txt',
        'refused',
      ],
    ]);
    expect(resume).not.toHaveBeenCalled();
    expect(attachmentsStore.peek()).toEqual([pending]);
    expect(composerDraftStore.get().request).toBeNull();
  });

  it('routes an image command into the composer draft instead of pending attachments', () => {
    projectDir = createTempDir('app-command-context-image');
    const imagePath = `${projectDir}/shot.png`;
    writeFileSync(imagePath, 'png-bytes');
    const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } });
    configStore.__testReset({ projectDir, config, diskConfig: config });

    const result = build().insertImage?.(imagePath);

    expect(result).toEqual({ ok: true, path: realpathSync(imagePath) });
    expect(composerDraftStore.get().request).toMatchObject({
      kind: 'image',
      attachment: { path: realpathSync(imagePath) },
    });
    expect(attachmentsStore.peek()).toEqual([]);
  });

  it('shows /queue with shared copy and counts each id only until first delivery', async () => {
    runViewStore.__testReset({ phase: 'implementing' });
    lifecycleStore.__testReset({ status: 'running' });
    seedBriefs({
      currentTask: 2,
      totalTasks: 3,
      tasks: [
        { id: 'T001', title: 'Done', status: 'done' },
        { id: 'T901', title: 'Inserted fix', status: 'in_progress' },
        { id: 'T002', title: 'Pending', status: 'pending' },
      ],
    });
    addEvent({ type: 'message_queued', ts: 1, phase: 'implementing', id: 'read' });
    addEvent({ type: 'message_queued', ts: 2, phase: 'implementing', id: 'pending' });
    addEvent({
      type: 'queue_drained',
      ts: 3,
      phase: 'implementing',
      seat: 'review',
      ids: ['read'],
      count: 1,
    });
    addEvent({
      type: 'queue_drained',
      ts: 4,
      phase: 'implementing',
      seat: 'build',
      ids: ['read'],
      count: 1,
    });
    const commands = workflowCommands(build());
    await executeRuntimeCommand(commands, '/queue show', {
      screen: 'workflow',
      phase: 'implementing',
      plannerSupportsImages: true,
      openRunAtRest: false,
      applyUnfinished: false,
      applying: false,
      onError: () => {},
    });
    expect(feedbackStore.get().message).toBe(
      queueCopy({ seat: 'build', taskId: 'T901', count: 1 }).byline,
    );
    addEvent({
      type: 'queue_drained',
      ts: 5,
      phase: 'implementing',
      seat: 'build',
      ids: ['pending'],
      count: 1,
    });
    await executeRuntimeCommand(commands, '/queue', {
      screen: 'workflow',
      phase: 'implementing',
      plannerSupportsImages: true,
      openRunAtRest: false,
      applyUnfinished: false,
      applying: false,
      onError: () => {},
    });
    expect(feedbackStore.get().message).toBe('Queue is empty');
  });

  it.each([
    ['run-start', '1 queued for BUILD on T001'],
    ['between-briefs', '1 queued for BUILD on T002'],
    ['after-last-brief', '1 queued for BUILD'],
  ] as const)(
    'names the brief BUILD reads the queue on at the %s boundary, where no brief runs',
    (boundary, summary) => {
      runViewStore.__testReset({ phase: 'implementing' });
      lifecycleStore.__testReset({ status: 'running' });
      for (const event of makeBriefBoundaryEvents(boundary)) addEvent(event);

      expect(build().getQueueCopy(1).summary).toBe(summary);
    },
  );

  it.each([0, 2])(
    'delegates /queue clear and formats its result with shared copy for %s messages',
    async (count) => {
      setClearQueueHandler(() => ({ status: 'cleared', count }));
      await executeRuntimeCommand(workflowCommands(build()), '/queue clear', {
        screen: 'workflow',
        phase: 'implementing',
        plannerSupportsImages: true,
        openRunAtRest: false,
        applyUnfinished: false,
        applying: false,
        onError: () => {},
      });
      expect(feedbackStore.get().message).toBe(queueCopy({ seat: null, count }).clearFeedback);
    },
  );

  it('copies a non-empty port-resolved message to the clipboard', async () => {
    const result = await build().copyTarget('message');

    expect(readClipboardExecCalls().at(-1)?.stdin).toBe('port-value');
    expect(result).toBe('native');
  });

  it('reports empty when the brief port resolves to null', async () => {
    const result = await build().copyTarget('brief');

    expect(readClipboardExecCalls()).toHaveLength(0);
    expect(result).toBe('empty');
  });

  it('scrolls the conversation to the bottom through the conversation scroll store', () => {
    conversationScrollStore.__testReset({ scrollOffset: 5 });

    const result = build().scrollConversation('bottom');

    expect(result).toEqual({ status: 'scrolled' });
    expect(conversationScrollStore.get().scrollOffset).toBe(0);
  });

  it('toggles the latest expandable activity batch through the conversation scroll store', () => {
    const key = seedExpandableActivityBatch();

    const result = build().toggleLatestActivityBatch();

    expect(result).toEqual({ status: 'toggled', expanded: true });
    expect(conversationScrollStore.get().expandedActivityBatches.has(key)).toBe(true);
  });

  it('toggles the workflow sidebar through the controls store', () => {
    terminalSizeStore.__testReset({ cols: 160, rows: 45, isSmall: false });
    const ctx = build();

    // The sidebar ships on, so the first toggle is the one that hides it.
    expect(controlsStore.get().sidebarVisible).toBe(true);
    expect(ctx.toggleSidebar()).toEqual({ status: 'toggled', visible: false });
    expect(controlsStore.get().sidebarVisible).toBe(false);
    expect(ctx.toggleSidebar()).toEqual({ status: 'toggled', visible: true });
    expect(controlsStore.get().sidebarVisible).toBe(true);
  });

  it('does not report the workflow sidebar as shown on small terminals', () => {
    terminalSizeStore.__testReset({ cols: 60, rows: 24, isSmall: true });

    expect(build().toggleSidebar()).toEqual({
      status: 'unavailable',
      message: 'Sidebar is hidden on small terminals.',
    });
    expect(controlsStore.get().sidebarVisible).toBe(true);
  });

  it('does not report the workflow sidebar as shown at the layout breakpoint', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });

    expect(build().toggleSidebar()).toEqual({
      status: 'unavailable',
      message: 'Sidebar is hidden on small terminals.',
    });
    expect(controlsStore.get().sidebarVisible).toBe(true);
  });

  it('toggles the sidebar on a run that has closed', () => {
    terminalSizeStore.__testReset({ cols: 160, rows: 40, isSmall: false });
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({ status: { kind: 'closed', as: 'complete' } }),
      execution: { kind: 'at-rest' },
    });

    expect(build().toggleSidebar()).toEqual({ status: 'toggled', visible: false });
    expect(controlsStore.get().sidebarVisible).toBe(false);
  });

  it('lists the planned briefs in plan order from the run view', () => {
    seedBriefs({
      tasks: [
        { id: 'T001', title: 'first', status: 'done' },
        { id: 'T002', title: 'second', status: 'in_progress' },
        { id: 'T003', title: 'third', status: 'pending' },
      ],
    });

    expect(build().listBriefs()).toEqual([
      { id: 'T001', status: 'done' },
      { id: 'T002', status: 'in_progress' },
      { id: 'T003', status: 'pending' },
    ]);
  });

  it('refreshDetection derives current settings instead of reusing prior service dependencies', async () => {
    // refreshDetection builds production deps and runs a real detection pass;
    // an empty PATH keeps it off this machine's real CLI tools (and their
    // now-all-admitted catalog probes) so the pass stays fast and hermetic.
    const savedPath = process.env.PATH;
    const emptyPathDir = createTempDir('app-command-context-empty-path');
    process.env.PATH = emptyPathDir;
    onTestFinished(() => {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    });
    projectDir = createTempDir('app-command-context-refresh');
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code', model: 'claude-opus-4' },
      implementer: { kind: 'api', provider: 'ollama', model: 'qwen2.5-coder:7b' },
    });
    configStore.__testReset({ projectDir, config, diskConfig: config });

    let detectCalls = 0;
    const deps: DetectionDeps = {
      detectAll: async () => {
        detectCalls++;
        return {
          providers: [
            {
              provider: 'ollama',
              available: true,
              isLocal: true,
              models: [{ id: 'old-private-model' }],
            },
          ],
          cliTools: [
            cliDetectionFor('ready', 'claude-code', {
              installedVersion: `old-dependency-${detectCalls}`,
            }),
          ],
        };
      },
      fetchModelsDevCatalog: async () => ({
        kind: 'fresh',
        snapshot: {
          sourceUrl: 'https://models.dev/api.json',
          parserVersion: 'test-parser',
          catalog: {},
          catalogState: 'empty',
          fetchedAt: 1_700_000_000_000,
          validatedAt: 1_700_000_000_000,
        },
      }),
      discoverAllCliTools: vi.fn().mockResolvedValue({}),
      sourceContexts: {
        readiness: 'old-command-context-readiness',
        modelsDev: 'old-command-context-models-dev',
        cliModels: 'old-command-context-cli-models',
      },
    };

    await getDefaultDetectionService().loadDetection({ deps, projectDir });
    detectionStore.reset();
    expect(detectionStore.get().cliTools).toEqual([]);

    const summary = await build().refreshDetection();

    expect(summary.status).not.toBe('uninitialized');
    expect(
      detectionStore.get().cliTools.some((tool) => tool.installedVersion === 'old-dependency-2'),
    ).toBe(false);
    expect(
      detectionStore
        .get()
        .providers.flatMap((provider) => provider.models ?? [])
        .some((model) => model.id === 'old-private-model'),
    ).toBe(false);
    expect(configStore.get().config?.planner).toEqual(config.planner);
    expect(configStore.get().config?.implementer.model).toBe(config.implementer.model);
  });
});

function skill(id: string, scope: 'global' | 'project'): SkillMeta {
  return {
    id,
    name: `${id} name`,
    description: `${id} description`,
    path: `/skills/${id}/SKILL.md`,
    scope,
  };
}

describe('buildCommandContext skills ports', () => {
  beforeEach(() => {
    resetAllStores();
  });

  afterEach(() => {
    resetAllStores();
  });

  it('ranks project skills, then selected global skills, then the rest', () => {
    skillsStore.setAvailable([
      skill('global-a', 'global'),
      skill('project-a', 'project'),
      skill('global-b', 'global'),
      skill('project-b', 'project'),
      skill('global-c', 'global'),
    ]);
    skillsStore.setSelected(new Set(['global-b']));

    const options = build().listSkills();

    expect(options.map((option) => option.id)).toEqual([
      'project-a',
      'project-b',
      'global-b',
      'global-a',
      'global-c',
    ]);
  });

  it('lists each skill as an id, name, description and whether it is attached', () => {
    skillsStore.setAvailable([skill('project-a', 'project'), skill('global-a', 'global')]);
    skillsStore.setSelected(new Set(['project-a']));

    expect(build().listSkills()).toEqual([
      {
        id: 'project-a',
        name: 'project-a name',
        description: 'project-a description',
        attached: true,
      },
      {
        id: 'global-a',
        name: 'global-a name',
        description: 'global-a description',
        attached: false,
      },
    ]);
  });

  it('reports selected and deselected when toggling a known skill', () => {
    skillsStore.setAvailable([skill('project-a', 'project')]);
    const ctx = build();

    expect(ctx.toggleSkill('project-a')).toEqual({ status: 'selected', name: 'project-a name' });
    expect(skillsStore.get().selected.has('project-a')).toBe(true);

    expect(ctx.toggleSkill('project-a')).toEqual({ status: 'deselected', name: 'project-a name' });
    expect(skillsStore.get().selected.has('project-a')).toBe(false);
  });

  it('reports unknown for a skill id that is not available', () => {
    skillsStore.setAvailable([skill('project-a', 'project')]);

    expect(build().toggleSkill('nope')).toEqual({ status: 'unknown' });
    expect(skillsStore.get().selected.size).toBe(0);
  });
});

function RuntimeCommandsHarness({
  onModel,
  phase = 'idle',
}: {
  onModel: (model: ReturnType<typeof useRuntimeCommands>) => void;
  phase?: Phase;
}) {
  const model = useRuntimeCommands({ exit: () => {}, phase });
  onModel(model);
  const snapshot = readConversationScrollSnapshot();
  return createElement(ConversationFlow, {
    height: snapshot.transcriptViewportHeight,
    conversationWidth: snapshot.conversationWidth,
    contentWidth: snapshot.contentRect.width,
  });
}

// The command list draws over the rows above the footer, so the frame keeps rows there for it.
function CommandComposerHarness({ phase = 'implementing' }: { phase?: Phase }) {
  const model = useRuntimeCommands({ exit: () => {}, phase });
  return createElement(
    Box,
    { flexDirection: 'column' },
    createElement(Box, { height: 14 }),
    createElement(WorkflowFooter, {
      commands: model.commands,
      mode: 'normal',
      inputHint: '',
      handleInput: () => {},
      disabled: false,
      onRuntimeCommand: (raw) => model.handleRuntimeCommand(raw, 'workflow'),
      listProjectFiles: async () => [],
    }),
  );
}

// Home names its keys in the home hint row, and a reason replaces that row.
function HomeCommandComposerHarness() {
  const model = useRuntimeCommands({ exit: () => {}, phase: 'idle' });
  return createElement(
    Box,
    { flexDirection: 'column' },
    createElement(Box, { height: 14 }),
    createElement(Composer, {
      commands: model.commands,
      currentScreen: 'home',
      mode: 'normal',
      hint: '',
      homeHint: '/help · /settings',
      onRuntimeCommand: (raw) => model.handleRuntimeCommand(raw, 'home'),
      listProjectFiles: async () => [],
    }),
  );
}

describe('useRuntimeCommands', () => {
  beforeEach(() => {
    resetAllStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists no /diff for a /di draft after a brief whose done row holds a diff', async () => {
    projectDir = createTempDir('command-composer-diff-list');
    configStore.__testReset({ projectDir, config: makeConfig() });
    terminalSizeStore.__testReset({ cols: 120, rows: 30, isSmall: false });
    addEvent(makeImplementerGenerate({ diff: '+ export const total = 1;' }));
    const ui = renderFeature(createElement(CommandComposerHarness), { cols: 120, rows: 30 });
    onTestFinished(ui.unmount);
    await flushEffects();
    ui.stdin.write('/di');
    await vi.waitFor(() => {
      const frame = stripAnsiStyles(ui.lastFrame());
      expect(frame).toContain('> /di');
      expect(frame).toContain('↑↓ select');
    });
    await flushEffects();

    const frame = stripAnsiStyles(ui.lastFrame());
    expect(frame.split('\n').filter((line) => line.includes('/diff'))).toEqual([]);
  });

  it('the palette activity command and /activity toggle the latest batch after the context was created', async () => {
    let runtime: ReturnType<typeof useRuntimeCommands> | undefined;
    const ui = renderFeature(
      createElement(RuntimeCommandsHarness, {
        onModel: (model) => {
          runtime = model;
        },
      }),
    );
    onTestFinished(ui.unmount);
    await flushEffects();
    if (runtime === undefined) throw new Error('Expected runtime commands');
    const command = runtime.commands.find((command) => command.name === '/activity');
    if (command?.kind !== 'noarg') throw new Error('Expected palette activity command');
    const key = seedExpandableActivityBatch();
    await flushEffects();
    expect(stripAnsiStyles(ui.lastFrame())).not.toContain('a.ts');

    await command.handler();
    await expect.poll(() => stripAnsiStyles(ui.lastFrame())).toContain('a.ts');
    expect(conversationScrollStore.get().expandedActivityBatches).toEqual(new Set([key]));

    runtime.handleRuntimeCommand('/activity', 'workflow');
    await expect.poll(() => conversationScrollStore.get().expandedActivityBatches.size).toBe(0);
    await expect.poll(() => stripAnsiStyles(ui.lastFrame())).not.toContain('a.ts');
  });

  it('keeps a refused steer command in the composer for a successful retry', async () => {
    terminalSizeStore.__testReset({ cols: 160, rows: 24, isSmall: false });
    projectDir = createTempDir('command-composer-steer');
    configStore.__testReset({ projectDir, config: makeConfig() });
    // The typed path is relative to the project, so the draft fits one row for any temp folder.
    const path = './context.txt';
    const document = createDraftDocument(`/steer use @${path}`);
    const pending = {
      id: 'pending',
      kind: 'image' as const,
      path: '/outside/pending.png',
      mimeType: 'image/png' as const,
      sizeBytes: 1,
    };
    attachmentsStore.replacePendingImages([pending]);
    inputHistoryStore.hydrate(['Earlier']);
    const resumed: string[] = [];
    setResumeHandler((message) => {
      resumed.push(message.text);
      return undefined;
    });
    const ui = renderFeature(createElement(CommandComposerHarness), { cols: 160, rows: 24 });
    onTestFinished(ui.unmount);
    await flushEffects();
    composerDraftStore.requestDocument(document);
    await flushEffects();

    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(feedbackStore.get().message).toBe(
        'Cannot send: file not found. Check the path and try again. File: context.txt.',
      );
    });
    await vi.waitFor(() => {
      expect(composerLiveStore.get().document).toEqual(document);
    });
    await flushEffects();
    expect(inputHistoryStore.get().workflowEntries).toEqual([document]);
    expect(attachmentsStore.peek()).toEqual([pending]);
    expect(resumed).toEqual([]);
    expect(ui.lastFrame()).toContain(`/steer use @${path}`);

    writeFileSync(join(projectDir, 'context.txt'), 'context body');
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(resumed).toEqual([`use @${path}\n\n--- @${path} ---\ncontext body`]);
      expect(composerLiveStore.get().empty).toBe(true);
    });
    expect(inputHistoryStore.get().workflowEntries).toEqual([document]);
  });

  it('keeps /steer use @/missing/x.md in the composer with one refusal line', async () => {
    projectDir = createTempDir('command-composer-missing');
    configStore.__testReset({ projectDir, config: makeConfig() });
    terminalSizeStore.__testReset({ cols: 160, rows: 24, isSmall: false });
    const document = createDraftDocument('/steer use @/missing/x.md');
    const earlier = createDraftDocument('Earlier');
    inputHistoryStore.pushDocumentSubmission(earlier, { currentScreen: 'workflow' });
    const resumed = vi.fn();
    setResumeHandler(resumed);
    const ui = renderFeature(createElement(CommandComposerHarness), { cols: 160, rows: 24 });
    onTestFinished(ui.unmount);
    await flushEffects();
    composerDraftStore.requestDocument(document);
    await flushEffects();
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame())).toContain('/steer use @/missing/x.md');
    });
    await flushEffects();

    const refusal = 'Cannot send: file not found. Check the path and try again. File: x.md.';
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(feedbackStore.get(), stripAnsiStyles(ui.lastFrame())).toEqual({
        message: refusal,
        severity: 'warning',
      });
    });
    await vi.waitFor(() => {
      expect(composerLiveStore.get().document).toEqual(document);
    });
    await flushEffects();
    const frame = stripAnsiStyles(ui.lastFrame());
    expect(frame).toContain('/steer use @/missing/x.md');
    expect(frame.split(refusal)).toHaveLength(2);
    expect(inputHistoryStore.get().workflowEntries).toEqual([document, earlier]);
    expect(resumed).not.toHaveBeenCalled();
  });

  it('keeps a newer draft when a steer refusal waits behind an asynchronous copy', async () => {
    projectDir = createTempDir('command-composer-queued-steer');
    configStore.__testReset({ projectDir, config: makeConfig() });
    terminalSizeStore.__testReset({ cols: 160, rows: 24, isSmall: false });
    addEvent({ type: 'planner_text', ts: 1, phase: 'implementing', text: 'Copy this message' });
    const copy = Promise.withResolvers<clipboard.CopyOutcome>();
    const copyToClipboard = vi.spyOn(clipboard, 'copyToClipboard').mockReturnValue(copy.promise);
    onTestFinished(() => copy.resolve('native'));
    const resumed = vi.fn();
    setResumeHandler(resumed);
    const ui = renderFeature(createElement(CommandComposerHarness), { cols: 160, rows: 24 });
    onTestFinished(ui.unmount);
    await flushEffects();
    composerDraftStore.request('/copy');
    await flushEffects();

    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(copyToClipboard).toHaveBeenCalledExactlyOnceWith('Copy this message');
      expect(composerLiveStore.get().empty).toBe(true);
    });
    const command = createDraftDocument('/steer use @/missing/x.md');
    composerDraftStore.requestDocument(command);
    await flushEffects();
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(composerLiveStore.get().empty).toBe(true);
      expect(inputHistoryStore.get().entries).toEqual([command, createDraftDocument('/copy')]);
    });
    ui.stdin.write('Newer draft');
    const newer = createDraftDocument('Newer draft');
    await vi.waitFor(() => {
      expect(composerLiveStore.get().document).toEqual(newer);
    });
    expect(feedbackStore.get().severity).toBe('info');
    const draftRequest = composerDraftStore.get().request;

    copy.resolve('native');
    const refusal = 'Cannot send: file not found. Check the path and try again. File: x.md.';
    await vi.waitFor(() => {
      expect(feedbackStore.get()).toEqual({ message: refusal, severity: 'warning' });
    });
    await flushEffects();
    expect(composerLiveStore.get().document).toEqual(newer);
    expect(composerDraftStore.get().request).toBe(draftRequest);
    expect(inputHistoryStore.get().entries).toEqual([command, createDraftDocument('/copy')]);
    expect(resumed).not.toHaveBeenCalled();
    const frame = stripAnsiStyles(ui.lastFrame());
    expect(frame).toContain('Newer draft');
    expect(frame.split(refusal)).toHaveLength(2);
  });

  it('keeps the image atom requested by a successful image command', async () => {
    projectDir = createTempDir('command-composer-image');
    configStore.__testReset({
      projectDir,
      config: makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }),
    });
    const path = `${projectDir}/shot.png`;
    writeFileSync(path, 'png');
    const ui = renderFeature(createElement(CommandComposerHarness));
    onTestFinished(ui.unmount);
    await flushEffects();
    composerDraftStore.request(`/image ${path}`);
    await flushEffects();

    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(composerLiveStore.get().document.parts).toEqual([
        { kind: 'image', attachment: expect.objectContaining({ path: realpathSync(path) }) },
      ]);
    });
    expect(inputHistoryStore.get().workflowEntries).toEqual([
      createDraftDocument(`/image ${path}`),
    ]);
    expect(attachmentsStore.peek()).toEqual([]);
  });

  it('shows a refused command as a warning and gives the line back', async () => {
    let model: ReturnType<typeof useRuntimeCommands> | undefined;
    const ui = renderFeature(
      createElement(RuntimeCommandsHarness, {
        onModel: (m) => {
          model = m;
        },
      }),
    );
    onTestFinished(ui.unmount);
    await tick();

    model?.handleRuntimeCommand('/totally-unknown-xyz', 'home');
    await tick();

    const feedback = feedbackStore.get();
    expect(feedback.severity).toBe('warning');
    expect(feedback.message).toContain('Unknown command');
    expect(feedback.message).toContain('/totally-unknown-xyz');
    expect(composerDraftStore.get().request).toMatchObject({
      kind: 'prepend',
      value: '/totally-unknown-xyz',
    });
  });

  it('shows a refused steer attachment in the warning voice', async () => {
    projectDir = createTempDir('command-failure-voice');
    configStore.__testReset({ projectDir, config: makeConfig() });
    let model: ReturnType<typeof useRuntimeCommands> | undefined;
    const ui = renderFeature(
      createElement(RuntimeCommandsHarness, {
        phase: 'implementing',
        onModel: (m) => {
          model = m;
        },
      }),
    );
    onTestFinished(ui.unmount);
    await tick();

    model?.handleRuntimeCommand('/steer use @/definitely-missing/context.txt', 'workflow');
    await tick();

    expect(feedbackStore.get()).toEqual({
      message: 'Cannot send: file not found. Check the path and try again. File: context.txt.',
      severity: 'warning',
    });
  });

  // `afterSend` runs when the line left its field, before SPLITBRIEF refuses it.
  async function refuseSteer(sentBy?: 'row' | 'answer', afterSend?: () => void) {
    let model: ReturnType<typeof useRuntimeCommands> | undefined;
    const ui = renderFeature(
      createElement(RuntimeCommandsHarness, {
        onModel: (m) => {
          model = m;
        },
      }),
    );
    onTestFinished(ui.unmount);
    await tick();

    model?.handleRuntimeCommand('/steer words', 'workflow', sentBy);
    afterSend?.();
    await vi.waitFor(() => {
      expect(feedbackStore.get()).toEqual({
        message: 'No run to steer in this phase',
        severity: 'warning',
      });
    });
  }

  it('gives a refused command line back to the composer', async () => {
    await refuseSteer();

    expect(composerDraftStore.get().request).toMatchObject({
      kind: 'prepend',
      value: '/steer words',
    });
  });

  async function typeRefusedLine(line: string) {
    projectDir = createTempDir('command-composer-refused');
    configStore.__testReset({ projectDir, config: makeConfig() });
    terminalSizeStore.__testReset({ cols: 120, rows: 30, isSmall: false });
    const ui = renderFeature(createElement(CommandComposerHarness), { cols: 120, rows: 30 });
    onTestFinished(ui.unmount);
    await flushEffects();
    ui.stdin.write(line);
    await flushEffects();
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(feedbackStore.get().message).not.toBeNull();
      expect(feedbackStore.get().severity).toBe('warning');
      expect(composerLiveStore.get().text).toBe(line);
    });
    return ui;
  }

  it.each([
    ['/zzzz', 'Unknown command: /zzzz. Type /help for available commands.'],
    ['/steer', 'Usage: /steer <correction>'],
    ['/run reject', 'Usage: /run reject confirm'],
    ['/diff', 'Unknown command: /diff. Type /help for available commands.'],
  ])(
    'shows the reason of a refused %s and keeps the line, with the menu closed',
    async (line, reason) => {
      const ui = await typeRefusedLine(line);

      await vi.waitFor(() => {
        expect(stripAnsiStyles(ui.lastFrame())).toContain(reason);
      });
      const frame = stripAnsiStyles(ui.lastFrame());
      expect(frame).toContain(`> ${line}`);
      expect(frame).not.toContain('↑↓ select');
    },
  );

  it('shows the usage of a bare /steer over the waiting plan card and sends no change request', async () => {
    projectDir = createTempDir('command-composer-plan-card');
    configStore.__testReset({ projectDir, config: makeConfig() });
    terminalSizeStore.__testReset({ cols: 120, rows: 30, isSmall: false });
    runViewStore.__testReset({ phase: 'reviewing-plan' });
    lifecycleStore.__testReset({ status: 'running' });
    const held = Promise.withResolvers<ApprovalReviewResult>();
    const resolve = vi.fn<(value: ApprovalReviewResult | QuestionAnswer) => void>((value) => {
      if ('approved' in value) held.resolve(value);
    });
    const card = buildPromptCallbacks({
      inputMode: {
        mode: 'review',
        hint: '',
        questionEpoch: 0,
        setReviewMode: () => held.promise,
        setQuestionMode: async () => plainAnswer(''),
        resolve,
        resetMode: () => {},
      },
      abortedRef: { current: false },
      controller: new AbortController(),
    }).onApprovalNeeded('plan', '/tmp/plan.md', []);
    const ui = renderFeature(createElement(CommandComposerHarness, { phase: 'reviewing-plan' }), {
      cols: 120,
      rows: 30,
    });
    onTestFinished(ui.unmount);
    await flushEffects();
    ui.stdin.write('/steer');
    await flushEffects();
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(feedbackStore.get()).toEqual({
        message: 'Usage: /steer <correction>',
        severity: 'warning',
      });
      expect(composerLiveStore.get().text).toBe('/steer');
    });
    await flushEffects();

    const frame = stripAnsiStyles(ui.lastFrame());
    expect(frame).toContain('Usage: /steer <correction>');
    expect(frame).toContain('> /steer');
    expect(frame).not.toContain('↑↓ select');
    expect(resolve).not.toHaveBeenCalled();
    await expect(Promise.race([card, Promise.resolve('pending')])).resolves.toBe('pending');
  });

  it('shows the reason of a refused command filled in over a / draft, with the draft back and the menu closed until an edit', async () => {
    projectDir = createTempDir('command-composer-held-draft');
    configStore.__testReset({ projectDir, config: makeConfig() });
    terminalSizeStore.__testReset({ cols: 120, rows: 30, isSmall: false });
    const ui = renderFeature(createElement(CommandComposerHarness), { cols: 120, rows: 30 });
    onTestFinished(ui.unmount);
    await flushEffects();
    ui.stdin.write('/he');
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame())).toContain('↑↓ select');
    });
    composerDraftStore.requestCommand('/run ');
    await vi.waitFor(() => {
      expect(composerLiveStore.get().text).toBe('/run ');
    });
    await flushEffects();
    ui.stdin.write('reject');
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame())).toContain('> /run reject');
    });
    await flushEffects();

    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(feedbackStore.get()).toEqual({
        message: 'Usage: /run reject confirm',
        severity: 'warning',
      });
      expect(composerLiveStore.get().text).toBe('/he');
    });
    await flushEffects();
    const frame = stripAnsiStyles(ui.lastFrame());
    expect(frame).toContain('Usage: /run reject confirm');
    expect(frame).toContain('> /he');
    expect(frame).not.toContain('↑↓ select');

    ui.stdin.write('l');
    await vi.waitFor(() => {
      expect(composerLiveStore.get().text).toBe('/hel');
      expect(stripAnsiStyles(ui.lastFrame())).toContain('↑↓ select');
    });
  });

  it('opens the menu again after the first edit of a given-back line', async () => {
    const ui = await typeRefusedLine('/zzzz');

    ui.stdin.write('x');
    await vi.waitFor(() => {
      expect(composerLiveStore.get().text).toBe('/zzzzx');
      expect(stripAnsiStyles(ui.lastFrame())).toContain('↑↓ select');
    });
  });

  it('keeps the menu closed over a line that ↑ recalls, and opens it after the first edit', async () => {
    projectDir = createTempDir('command-composer-recall');
    configStore.__testReset({ projectDir, config: makeConfig() });
    terminalSizeStore.__testReset({ cols: 120, rows: 30, isSmall: false });
    inputHistoryStore.hydrate(['/zzzz']);
    const ui = renderFeature(createElement(CommandComposerHarness), { cols: 120, rows: 30 });
    onTestFinished(ui.unmount);
    await flushEffects();

    ui.stdin.write('\x1b[A');
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame())).toContain('> /zzzz');
    });
    expect(stripAnsiStyles(ui.lastFrame())).not.toContain('↑↓ select');

    ui.stdin.write('x');
    await vi.waitFor(() => {
      expect(composerLiveStore.get().text).toBe('/zzzzx');
      expect(stripAnsiStyles(ui.lastFrame())).toContain('↑↓ select');
    });
  });

  it('shows the reason of a command refused on Home and keeps the line, with the menu closed until an edit', async () => {
    const reason = 'Unknown command: /setings. Did you mean /settings?';
    projectDir = createTempDir('command-composer-home-refused');
    configStore.__testReset({ projectDir, config: makeConfig() });
    terminalSizeStore.__testReset({ cols: 120, rows: 30, isSmall: false });
    const ui = renderFeature(createElement(HomeCommandComposerHarness), { cols: 120, rows: 30 });
    onTestFinished(ui.unmount);
    await flushEffects();
    ui.stdin.write('/setings');
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame())).toContain('↑↓ select');
    });

    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(feedbackStore.get()).toEqual({ message: reason, severity: 'warning' });
      expect(composerLiveStore.get().text).toBe('/setings');
    });
    await flushEffects();
    const frame = stripAnsiStyles(ui.lastFrame());
    expect(frame).toContain(reason);
    expect(frame).toContain('> /setings');
    expect(frame).not.toContain('↑↓ select');

    ui.stdin.write('x');
    await vi.waitFor(() => {
      expect(composerLiveStore.get().text).toBe('/setingsx');
      expect(stripAnsiStyles(ui.lastFrame())).toContain('↑↓ select');
    });
  });

  it('opens the menu for a command that the palette fills in over a given-back line', async () => {
    const ui = await typeRefusedLine('/zzzz');

    composerDraftStore.requestCommand('/run ');
    await vi.waitFor(() => {
      expect(composerLiveStore.get().text).toBe('/run ');
      expect(stripAnsiStyles(ui.lastFrame())).toContain('↑↓ select');
    });
  });

  it('gives nothing back when a menu row sent the refused command', async () => {
    await refuseSteer('row');

    expect(composerDraftStore.get().request).toBeNull();
  });

  const QUESTION = { id: 'numbers', type: 'input' as const, text: 'Which numbers?' };

  it.each([
    ['an empty composer', ''],
    ['a composer draft', 'also fix the typo'],
  ])(
    'gives a command refused from the answer field back to that field, over %s',
    async (_, draft) => {
      composerLiveStore.setDraft(createDraftDocument(draft));
      questionPromptStore.setQuestions([QUESTION]);
      questionPromptStore.setFocus('answer', '');

      await refuseSteer('answer');

      expect(questionPromptStore.get()).toMatchObject({
        focus: 'answer',
        drafts: [{ text: '/steer words', selected: 0 }],
      });
      expect(composerDraftStore.get().request).toBeNull();
      expect(composerLiveStore.get().text).toBe(draft);
    },
  );

  it('keeps the words typed in the answer field after the refused command left it', async () => {
    questionPromptStore.setQuestions([QUESTION]);
    questionPromptStore.setFocus('answer', '');

    await refuseSteer('answer', () => questionPromptStore.setFocus('answer', 'integers only'));

    expect(composerDraftStore.get().request).toBeNull();
    expect(questionPromptStore.get().drafts).toEqual([{ text: 'integers only', selected: 0 }]);
  });

  it('leaves the answer field empty when its command runs', async () => {
    let model: ReturnType<typeof useRuntimeCommands> | undefined;
    const ui = renderFeature(
      createElement(RuntimeCommandsHarness, {
        onModel: (m) => {
          model = m;
        },
      }),
    );
    onTestFinished(ui.unmount);
    await tick();
    questionPromptStore.setQuestions([QUESTION]);
    questionPromptStore.setFocus('answer', '');

    model?.handleRuntimeCommand('/queue', 'workflow', 'answer');
    await vi.waitFor(() => {
      expect(feedbackStore.get()).toEqual({ message: 'Queue is empty', severity: 'info' });
    });

    expect(questionPromptStore.get().drafts).toEqual([{ text: '', selected: 0 }]);
    expect(composerDraftStore.get().request).toBeNull();
  });
});

describe('useRuntimeCommands while Apply writes the run at rest', () => {
  const sessionId = 'applying-run';
  const at = '2026-10-19T00:00:00.000Z';
  let model: ReturnType<typeof useRuntimeCommands> | undefined;
  let held = Promise.withResolvers<AcceptRunResult>();

  const readyState = (): WorkflowState =>
    makeWorkflowState({
      phase: 'complete',
      reviewStatus: 'passed',
      workspace: {
        kind: 'staged-copy',
        path: '/tmp/run-workspace',
        base: { snapshotId: 'workspace-base', head: null },
      },
    });

  function saveState(state: WorkflowState): void {
    writeFileSync(join(sessionDir(projectDir, sessionId), STATE_FILE), JSON.stringify(state));
  }

  function Harness() {
    model = useRuntimeCommands({
      exit: () => {},
      phase: 'complete',
      createContext: () => ({
        ...build(),
        acceptRun: () => trackActiveApply(held.promise),
      }),
    });
    return null;
  }

  async function settle(result: AcceptRunResult, state: WorkflowState): Promise<void> {
    saveState(state);
    held.resolve(result);
    await activeApply();
    await tick();
  }

  beforeEach(() => {
    resetAllStores();
    projectDir = createTempDir('commands-applying');
    configStore.__testReset({ config: makeConfig(), projectDir });
    mkdirSync(sessionDir(projectDir, sessionId), { recursive: true });
    saveState(readyState());
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({
        ref: { projectDir, sessionId },
        status: { kind: 'ready-to-apply', override: false },
        hydration: { kind: 'loaded', state: readyState() },
      }),
      execution: { kind: 'at-rest' },
    });
    held = Promise.withResolvers<AcceptRunResult>();
    onTestFinished(async () => {
      held.resolve({ status: 'halted' });
      await activeApply();
    });
  });

  async function startApply() {
    const ui = renderFeature(createElement(Harness));
    await tick();
    model?.handleRuntimeCommand('/run accept', 'workflow');
    await tick();
    expect(activeApply()).toBeDefined();
    return ui;
  }

  it('runs the next command while Apply is still writing', async () => {
    const ui = await startApply();

    model?.handleRuntimeCommand('/help', 'workflow');
    await tick();

    expect(overlayStore.get().active).toBe('help');
    ui.unmount();
  });

  it('queues /home behind Apply and goes home once Apply applies the run', async () => {
    const ui = await startApply();

    model?.handleRuntimeCommand('/home', 'workflow');
    await tick();
    expect(departureStore.get()?.kind).toBe('home');
    expect(routerStore.get().screen).toBe('workflow');

    await settle(
      { status: 'applied', files: ['a.txt'] },
      {
        ...readyState(),
        applied: { at, backupId: 'backup-1', files: ['a.txt'] },
        closed: { at, as: 'applied' },
      },
    );
    expect(routerStore.get().screen).toBe('home');
    ui.unmount();
  });

  it('drops a queued /home and shows the halt when Apply stops part way', async () => {
    const ui = await startApply();

    model?.handleRuntimeCommand('/home', 'workflow');
    await tick();
    await settle({ status: 'halted' }, readyState());

    expect(routerStore.get().screen).toBe('workflow');
    expect(departureStore.get()).toBeNull();
    expect(feedbackStore.get()).toMatchObject({
      severity: 'error',
      message: 'Apply stopped; resolve it in the recovery menu.',
    });
    ui.unmount();
  });

  it.each([
    ['/end', 'Apply is still writing to your checkout.'],
    ['/resume', 'Apply is still writing to your checkout.'],
    ['/steer use the other file', 'Apply is still writing to your checkout.'],
    ['/run accept', 'Apply is still writing to your checkout.'],
    ['/run reject confirm', 'Apply is still writing to your checkout.'],
    ['/stop', 'Nothing to stop: Apply finishes on its own.'],
  ])('refuses %s at once with one line', async (command, line) => {
    const ui = await startApply();

    model?.handleRuntimeCommand(command, 'workflow');
    await tick();

    expect(feedbackStore.get()).toMatchObject({ severity: 'warning', message: line });
    expect(overlayStore.get().active).toBe('none');
    expect(routerStore.get().screen).toBe('workflow');
    ui.unmount();
  });
});

function skillOptions(model: ReturnType<typeof useRuntimeCommands> | undefined): readonly string[] {
  const command = model?.commands.find((cmd) => cmd.name === '/skills');
  if (command === undefined || command.kind !== 'arg' || command.args.kind !== 'closed') {
    throw new Error('/skills is not a closed-argument command');
  }
  return command.args.options;
}

describe('useRuntimeCommands skills freshness', () => {
  beforeEach(() => {
    resetAllStores();
  });

  afterEach(() => {
    resetAllStores();
  });

  it('rebuilds the /skills option set when a rescan publishes new skills', async () => {
    skillsStore.setAvailable([skill('project-a', 'project')]);
    let model: ReturnType<typeof useRuntimeCommands> | undefined;
    const ui = renderFeature(
      createElement(RuntimeCommandsHarness, {
        onModel: (m) => {
          model = m;
        },
      }),
    );
    await tick();
    expect(skillOptions(model)).toEqual(['project-a']);

    skillsStore.setAvailable([skill('project-a', 'project'), skill('global-new', 'global')]);
    await tick();

    expect(skillOptions(model)).toContain('global-new');
    ui.unmount();
  });

  it('reorders the /skills options when a global skill is selected', async () => {
    skillsStore.setAvailable([
      skill('project-a', 'project'),
      skill('global-a', 'global'),
      skill('global-b', 'global'),
    ]);
    let model: ReturnType<typeof useRuntimeCommands> | undefined;
    const ui = renderFeature(
      createElement(RuntimeCommandsHarness, {
        onModel: (m) => {
          model = m;
        },
      }),
    );
    await tick();
    expect(skillOptions(model)).toEqual(['project-a', 'global-a', 'global-b']);

    skillsStore.setSelected(new Set(['global-b']));
    await tick();

    expect(skillOptions(model)).toEqual(['project-a', 'global-b', 'global-a']);
    ui.unmount();
  });
});
