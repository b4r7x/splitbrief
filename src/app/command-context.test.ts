import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  installClipboardExecFixture,
  readClipboardExecCalls,
  resetClipboardExecFixture,
  restoreClipboardExecFixture,
} from '#testing/helpers/clipboard-exec-fixture.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { EngineEventOf } from '../engine/events/types.js';
import type { RewindTarget } from '../core/state/build-rewind-action.js';
import {
  setClearQueueHandler,
  setRewindHandler,
  clearAllHandlers,
  requestClearQueue,
  requestRewind,
} from '../features/workflow/handlers.js';
import {
  activityBatchKey,
  findLatestExpandableActivityBatchKey,
} from '../features/workflow/conversation-rows/activity-batch-key.js';
import { readConversationScrollSnapshot } from '../features/workflow/layout/snapshot.js';
import { findLatestRenderableDiffKey } from '../core/sections/event-sections.js';
import { configStore } from '../stores/project/config.js';
import { addEvent } from '../stores/workflow/actions/event.js';
import { getSections } from '../stores/workflow/actions/sections.js';
import { conversationScrollStore } from '../stores/workflow/conversation-scroll.js';
import { controlsStore } from '../stores/ui/controls.js';
import { feedbackStore } from '../stores/ui/feedback.js';
import { terminalSizeStore } from '../stores/ui/terminal-size.js';
import { routerStore } from '../stores/navigation/router.js';
import { createRuntimeCommands } from '../core/runtime/commands/registry.js';
import { makeRunnerCallActivity } from '#testing/helpers/events/runner-call.js';
import {
  buildCommandContext,
  useRuntimeCommands,
  type WorkflowCommandPorts,
} from './command-context.js';
import { detectionStore } from '../stores/project/detection.js';
import { getDefaultDetectionService, type DetectionDeps } from '../engine/detection/service.js';

let projectDir = '';
const originalPlatform = process.platform;

const workflowPorts: WorkflowCommandPorts = {
  requestRewind,
  requestClearQueue,
  findLatestActivityBatchKey: () => findLatestExpandableActivityBatchKey(getSections()),
  findLatestDiffKey: () => findLatestRenderableDiffKey(getSections()),
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
  it('delegates queue clearing to the live workflow handler', () => {
    setClearQueueHandler(() => ({ status: 'cleared', count: 2 }));

    expect(build().clearQueue()).toEqual({
      status: 'cleared',
      count: 2,
    });
  });

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

  it('routes rewind requests to the live workflow handler', () => {
    const requests: RewindTarget[] = [];
    setRewindHandler((request) => requests.push(request));

    build().requestRewind('spec', 'redo');

    expect(requests).toEqual([{ target: 'spec', comment: 'redo' }]);
  });

  it('routes task redo through the live rewind handler', () => {
    const requests: RewindTarget[] = [];
    setRewindHandler((request) => requests.push(request));

    build().requestTaskRedo('T-1');

    expect(requests).toEqual([{ target: 'task', taskId: 'T-1' }]);
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
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
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

  it('is not attached for an in-process session', () => {
    expect(build().isAttached).toBe(false);
  });

  it('hides local-only workflow mutation commands when attached', () => {
    routerStore.init({
      screen: 'workflow',
      execution: {
        kind: 'attached',
        feature: 'feat',
        sessionId: 's1',
        attach: { sockPath: '/tmp/s.sock', authToken: 'tok' },
      },
    });

    const names = createRuntimeCommands(build()).map((cmd) => cmd.name);

    expect(names).not.toContain('/yolo');
    expect(names).not.toContain('/revise-spec');
    expect(names).not.toContain('/attach');
    expect(names).toContain('/copy');
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
      fetchModelsDevCatalog: vi.fn().mockResolvedValue({}),
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

function RuntimeCommandsHarness({
  onModel,
}: {
  onModel: (model: ReturnType<typeof useRuntimeCommands>) => void;
}) {
  const model = useRuntimeCommands({ exit: () => {}, phase: 'idle' });
  onModel(model);
  return null;
}

describe('useRuntimeCommands', () => {
  beforeEach(() => {
    resetAllStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
