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
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { routerStore } from '../stores/navigation/router.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { EngineEventOf } from '../engine/events/types.js';
import type { AcceptRunResult } from '../core/runtime/commands/types.js';
import type { WorkflowState } from '../core/schemas/workflow.js';
import { STATE_FILE, sessionDir } from '../core/paths.js';
import {
  activeApply,
  trackActiveApply,
} from '../engine/orchestrator/session-lifecycle/shutdown.js';
import { departureStore } from '../stores/workflow/departure.js';
import { overlayStore } from '../stores/ui/overlay.js';
import { taskId } from '../core/schemas/task.js';
import {
  setClearQueueHandler,
  clearAllHandlers,
  requestClearQueue,
  setResumeHandler,
} from '../features/workflow/handlers.js';
import { executeRuntimeCommand } from '../core/runtime/commands/dispatch.js';
import { workflowCommands } from '../core/runtime/commands/defs/workflow.js';
import { activityBatchKey } from '../features/workflow/conversation-rows/activity-batch-key.js';
import { readConversationRowActions } from '../features/workflow/conversation-rows/read-row-actions.js';
import { readConversationScrollSnapshot } from '../features/workflow/layout/snapshot.js';
import { configStore } from '../stores/project/config.js';
import { composerDraftStore } from '../stores/ui/composer-draft.js';
import { composerLiveStore } from '../stores/ui/composer-live.js';
import { inputHistoryStore } from '../stores/ui/input-history.js';
import { WorkflowFooter } from '../features/workflow/components/chrome.js';
import { createDraftDocument } from '../core/composer/document.js';
import { attachmentsStore } from '../stores/workflow/attachments.js';
import { skillsStore } from '../stores/project/skills.js';
import type { SkillMeta } from '../core/skills/types.js';
import { addEvent } from '../stores/workflow/actions/event.js';
import { conversationScrollStore } from '../stores/workflow/conversation-scroll.js';
import { lifecycleStore } from '../stores/workflow/lifecycle.js';
import { queueCopy } from '../features/workflow/queue-copy.js';
import { tasksStore } from '../stores/workflow/tasks.js';
import { controlsStore } from '../stores/ui/controls.js';
import { feedbackStore } from '../stores/ui/feedback.js';
import { terminalSizeStore } from '../stores/ui/terminal-size.js';
import { makeRunnerCallActivity } from '#testing/helpers/events/runner-call.js';
import { makeImplementerGenerate } from '#testing/helpers/events/implementer.js';
import { ConversationFlow } from '../features/workflow/components/conversation-flow/flow.js';
import {
  buildCommandContext,
  useRuntimeCommands,
  type WorkflowCommandPorts,
} from './command-context.js';
import { detectionStore } from '../stores/project/detection.js';
import { getDefaultDetectionService, type DetectionDeps } from '../engine/detection/service.js';
import * as clipboard from '../lib/clipboard/clipboard.js';

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

    expect(build().steerRun(`use @${path}`)).toBe(true);
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
    const onError = vi.fn(feedbackStore.setError);

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

    expect(feedbackStore.get()).toEqual({
      message: 'Cannot send: file not found. Check the path and try again. File: context.txt.',
      isError: true,
    });
    expect(onError).toHaveBeenCalledOnce();
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
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running' });
    tasksStore.__testReset({
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

  it('reports empty when the message port resolves to null', async () => {
    const result = await build().copyTarget('cost');

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

  it('does not report a sidebar on a run that has closed', () => {
    terminalSizeStore.__testReset({ cols: 160, rows: 40, isSmall: false });
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({ status: { kind: 'closed', as: 'complete' } }),
      execution: { kind: 'at-rest' },
    });

    expect(build().toggleSidebar()).toEqual({
      status: 'unavailable',
      message: 'A closed run has no sidebar.',
    });
    expect(controlsStore.get().sidebarVisible).toBe(true);
  });

  it('lists the planned briefs in plan order from the tasks store', () => {
    tasksStore.__testReset({
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
}: {
  onModel: (model: ReturnType<typeof useRuntimeCommands>) => void;
}) {
  const model = useRuntimeCommands({ exit: () => {}, phase: 'idle' });
  onModel(model);
  const snapshot = readConversationScrollSnapshot();
  return createElement(ConversationFlow, {
    height: snapshot.transcriptViewportHeight,
    conversationWidth: snapshot.conversationWidth,
    contentWidth: snapshot.contentRect.width,
  });
}

function CommandComposerHarness() {
  const model = useRuntimeCommands({ exit: () => {}, phase: 'implementing' });
  return createElement(WorkflowFooter, {
    commands: model.commands,
    mode: 'normal',
    inputHint: '',
    handleInput: () => {},
    disabled: false,
    onRuntimeCommand: (raw) => model.handleRuntimeCommand(raw, 'workflow'),
    listProjectFiles: async () => [],
  });
}

describe('useRuntimeCommands', () => {
  beforeEach(() => {
    resetAllStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('the palette diff command expands automatic Recovery details and /diff collapses them', async () => {
    const words = 'provider.quota: Insufficient Balance (request_id: spent-b2)';
    addEvent(
      makeRunnerCallActivity({
        callId: 'spent-build',
        phase: 'implementing',
        taskId: taskId('T001'),
        runnerName: 'opencode',
        model: 'deepseek/deepseek-flash',
        kind: 'error',
        diagnosticPartial: words,
      }),
    );
    addEvent(
      makeImplementerGenerate({ status: 'failed', model: 'deepseek/deepseek-flash', error: words }),
    );
    addEvent({
      type: 'recovery_prompted',
      ts: 2,
      phase: 'implementing',
      taskId: taskId('T001'),
      issueId: 'spent-b2',
      reason: 'runner-usage-limit',
      headline: 'Balance spent on OpenCode CLI',
      files: [],
      affectedTaskIds: [taskId('T001')],
      availableActions: ['switch-seat'],
      recommendedAction: 'switch-seat',
      resumeCommand: 'splitbrief continue',
    });
    addEvent({
      type: 'recovery_action_selected',
      ts: 3,
      phase: 'implementing',
      issueId: 'spent-b2',
      reason: 'runner-usage-limit',
      action: 'switch-seat',
      seat: 'build',
    });
    addEvent({
      type: 'seat_switched',
      ts: 4,
      phase: 'implementing',
      seat: 'build',
      from: { tool: 'opencode', model: 'deepseek/deepseek-flash' },
      to: { tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', variant: 'high' },
      cause: 'runner-usage-limit',
      auto: true,
      configRevision: 'spent-b2',
    });
    addEvent({
      type: 'recovery_resolved',
      ts: 5,
      phase: 'implementing',
      issueId: 'spent-b2',
      reason: 'runner-usage-limit',
      action: 'switch-seat',
      seat: 'build',
      outcome: 'retry-current-task',
    });
    terminalSizeStore.__testReset({ cols: 120, rows: 40 });
    let runtime: ReturnType<typeof useRuntimeCommands> | undefined;
    const ui = renderFeature(
      createElement(RuntimeCommandsHarness, {
        onModel: (model) => {
          runtime = model;
        },
      }),
      { cols: 120, rows: 40 },
    );
    onTestFinished(ui.unmount);
    await flushEffects();
    if (runtime === undefined) throw new Error('Expected runtime commands');
    const command = runtime.commands.find((command) => command.name === '/diff');
    if (command?.kind !== 'noarg') throw new Error('Expected palette diff command');
    expect(stripAnsiStyles(ui.lastFrame())).toContain('continued on fallback');
    expect(stripAnsiStyles(ui.lastFrame())).not.toContain(words);

    await command.handler();
    await expect.poll(() => stripAnsiStyles(ui.lastFrame())).toContain(words);
    expect(conversationScrollStore.get().expandedDiffs).toEqual(new Set(['recovery_prompted:2']));
    expect(feedbackStore.get()).toEqual({ message: 'Expanded latest diff', isError: false });

    runtime.handleRuntimeCommand('/diff', 'workflow');
    await expect.poll(() => conversationScrollStore.get().expandedDiffs.size).toBe(0);
    await expect.poll(() => stripAnsiStyles(ui.lastFrame())).not.toContain(words);
    expect(feedbackStore.get()).toEqual({ message: 'Collapsed latest diff', isError: false });
  });

  it('the palette and runtime diff command toggle a cut failure card after the context was created', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 40 });
    let runtime: ReturnType<typeof useRuntimeCommands> | undefined;
    const ui = renderFeature(
      createElement(RuntimeCommandsHarness, {
        onModel: (model) => {
          runtime = model;
        },
      }),
      { cols: 120, rows: 40 },
    );
    onTestFinished(ui.unmount);
    await flushEffects();
    if (runtime === undefined) throw new Error('Expected runtime commands');
    const command = runtime.commands.find((command) => command.name === '/diff');
    if (command?.kind !== 'noarg') throw new Error('Expected palette diff command');
    expect(build().toggleLatestDiff().status).toBe('unavailable');
    addEvent(makeImplementerGenerate({ status: 'done', diff: '+ earlier' }));
    const words = `Runner failed ${'while applying the brief '.repeat(8)}raw-end`;
    addEvent(makeImplementerGenerate({ status: 'failed', error: words }));
    await flushEffects();
    expect(stripAnsiStyles(ui.lastFrame())).not.toContain('raw-end');

    await command.handler();
    await expect.poll(() => stripAnsiStyles(ui.lastFrame())).toContain('raw-end');
    expect(conversationScrollStore.get().expandedDiffs).toEqual(
      new Set(['implementer_generate_failed:1']),
    );

    runtime.handleRuntimeCommand('/diff', 'workflow');
    await expect.poll(() => conversationScrollStore.get().expandedDiffs.size).toBe(0);
    await expect.poll(() => stripAnsiStyles(ui.lastFrame())).not.toContain('raw-end');
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

  it('recalls a refused steer command from history before a successful retry', async () => {
    terminalSizeStore.__testReset({ cols: 160, rows: 24, isSmall: false });
    projectDir = createTempDir('command-composer-steer');
    configStore.__testReset({ projectDir, config: makeConfig() });
    const path = `${projectDir}/context.txt`;
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
    setResumeHandler((message) => resumed.push(message.text));
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
    await flushEffects();
    expect(composerLiveStore.get().document).toEqual(createDraftDocument(''));
    expect(inputHistoryStore.get().workflowEntries).toEqual([document]);
    expect(attachmentsStore.peek()).toEqual([pending]);
    expect(resumed).toEqual([]);
    expect(ui.lastFrame()).not.toContain(`/steer use @${path}`);

    writeFileSync(path, 'context body');
    ui.stdin.write('\u001b[A');
    await vi.waitFor(() => {
      expect(composerLiveStore.get().document).toEqual(document);
    });
    await flushEffects();
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(resumed).toEqual([`use @${path}\n\n--- @${path} ---\ncontext body`]);
      expect(composerLiveStore.get().empty).toBe(true);
    });
    expect(inputHistoryStore.get().workflowEntries).toEqual([document]);
  });

  it('clears /steer use @/missing/x.md with one refusal line and recalls it with Up', async () => {
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
        isError: true,
      });
    });
    await flushEffects();
    expect(composerLiveStore.get().document).toEqual(createDraftDocument(''));
    const frame = stripAnsiStyles(ui.lastFrame());
    expect(frame).not.toContain('/steer use @/missing/x.md');
    expect(frame).toContain(refusal);
    expect(frame.split(refusal)).toHaveLength(2);
    expect(inputHistoryStore.get().workflowEntries).toEqual([document, earlier]);
    expect(resumed).not.toHaveBeenCalled();

    ui.stdin.write('\u001b[A');
    await vi.waitFor(() => {
      expect(composerLiveStore.get().document).toEqual(document);
    });
    await flushEffects();
    expect(stripAnsiStyles(ui.lastFrame())).toContain('/steer use @/missing/x.md');
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
    expect(feedbackStore.get().isError).toBe(false);
    const draftRequest = composerDraftStore.get().request;

    copy.resolve('native');
    const refusal = 'Cannot send: file not found. Check the path and try again. File: x.md.';
    await vi.waitFor(() => {
      expect(feedbackStore.get()).toEqual({ message: refusal, isError: true });
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

  it('surfaces an unknown command as feedback error state', async () => {
    let model: ReturnType<typeof useRuntimeCommands> | undefined;
    const ui = renderFeature(
      createElement(RuntimeCommandsHarness, {
        onModel: (m) => {
          model = m;
        },
      }),
    );
    await tick();

    model?.handleRuntimeCommand('/totally-unknown-xyz', 'home');
    await tick();

    const feedback = feedbackStore.get();
    expect(feedback.isError).toBe(true);
    expect(feedback.message).toContain('Unknown command');
    expect(feedback.message).toContain('/totally-unknown-xyz');
    ui.unmount();
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
      isError: true,
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

    expect(feedbackStore.get()).toMatchObject({ isError: true, message: line });
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
