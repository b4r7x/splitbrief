import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installClipboardExecFixture,
  readClipboardExecCalls,
  resetClipboardExecFixture,
  restoreClipboardExecFixture,
} from '#testing/helpers/clipboard-exec-fixture.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
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
import { resolveCopyValue } from '../features/workflow/copy/resolve.js';
import { configStore } from '../stores/project/config.js';
import { addEvent, getSections } from '../stores/workflow/actions.js';
import { conversationScrollStore } from '../stores/workflow/conversation-scroll.js';
import { controlsStore } from '../stores/ui/controls.js';
import { terminalSizeStore } from '../stores/ui/terminal-size.js';
import { reviewStore } from '../stores/workflow/review.js';
import { focusStore } from '../stores/ui/focus.js';
import { routerStore } from '../stores/navigation/router.js';
import { createRuntimeCommands } from '../core/runtime/commands/registry.js';
import { buildCommandContext, type WorkflowCommandPorts } from './command-context.js';
import { detectionStore } from '../stores/project/detection.js';
import { loadDetectionIntoStores } from '../stores/discovery/detection-adapter.js';
import { getDefaultDetectionService, type DetectionDeps } from '../engine/detection/service.js';

let projectDir = '';
const originalPlatform = process.platform;

const workflowPorts: WorkflowCommandPorts = {
  requestRewind,
  requestClearQueue,
  findLatestActivityBatchKey: () => findLatestExpandableActivityBatchKey(getSections()),
  readScrollMetrics: readConversationScrollSnapshot,
  resolveCopyValue,
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
  return {
    type: 'runner_call_activity',
    ts: overrides.ts ?? 0,
    phase: overrides.phase ?? 'researching',
    callId: overrides.callId ?? 'call-1',
    role: overrides.role ?? 'planner',
    backendKind: overrides.backendKind ?? 'cli',
    runnerName: overrides.runnerName ?? 'codex',
    sequence: overrides.sequence ?? 1,
    activityId: overrides.activityId ?? 'activity-1',
    stage: overrides.stage ?? 'updated',
    kind: overrides.kind ?? 'read',
    label: overrides.label ?? 'reading file.ts',
    redacted: overrides.redacted ?? false,
    ...(overrides.target !== undefined && { target: overrides.target }),
  };
}

function seedExpandableActivityBatch(): string {
  addEvent(activity({ sequence: 1, activityId: 'a', label: 'reading a.ts' }));
  addEvent(activity({ sequence: 2, activityId: 'b', label: 'reading b.ts' }));
  addEvent(activity({ sequence: 3, activityId: 'c', label: 'reading c.ts' }));
  addEvent(activity({ sequence: 4, activityId: 'd', label: 'reading d.ts' }));
  return activityBatchKey(0, 'call-1');
}

describe('buildCommandContext', () => {
  it('rebuilds the repo-map cache from the configured cacheDir', async () => {
    projectDir = createTempDir('app-command-context');
    const config = makeConfig({
      codebase: { enabled: true, tokenBudget: 4000, cacheDir: '.custom-cache' },
    });
    configStore.__testReset({ projectDir, config, diskConfig: config });
    const cacheDir = join(projectDir, '.custom-cache');
    mkdirSync(cacheDir, { recursive: true });
    const cacheFile = join(cacheDir, 'repomap.sqlite');
    writeFileSync(cacheFile, 'cache');

    const result = await build().rebuildRepomap();

    expect(result).toEqual({ deleted: true, files: [cacheFile] });
    expect(existsSync(cacheFile)).toBe(false);
  });

  it('delegates queue clearing to the live workflow handler', () => {
    setClearQueueHandler(() => ({ status: 'cleared', count: 2 }));

    expect(build().clearQueue()).toEqual({
      status: 'cleared',
      count: 2,
    });
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

    expect(ctx.toggleSidebar()).toEqual({ status: 'toggled', visible: true });
    expect(controlsStore.get().sidebarVisible).toBe(true);
    expect(ctx.toggleSidebar()).toEqual({ status: 'toggled', visible: false });
    expect(controlsStore.get().sidebarVisible).toBe(false);
  });

  it('does not report the workflow sidebar as shown on small terminals', () => {
    terminalSizeStore.__testReset({ cols: 60, rows: 24, isSmall: true });

    expect(build().toggleSidebar()).toEqual({
      status: 'unavailable',
      message: 'Sidebar is hidden on small terminals.',
    });
    expect(controlsStore.get().sidebarVisible).toBe(false);
  });

  it('forwards the focused brief row file to the clipboard for the path target', async () => {
    reviewStore.setBriefPaths(['src/a.ts', 'src/b.ts']);
    reviewStore.setRenderedLineCount(2);
    reviewStore.setVisibleBriefCount(2);
    focusStore.set('brief', 1);

    const result = await build().copyTarget('path');

    expect(readClipboardExecCalls().at(-1)?.stdin).toBe('src/b.ts');
    expect(result).toBe('native');
  });

  it('reports empty without copying when the path target has no brief rows', async () => {
    reviewStore.clearReview();

    const result = await build().copyTarget('path');

    expect(readClipboardExecCalls()).toHaveLength(0);
    expect(result).toBe('empty');
  });

  it('copies the focused brief raw markdown for the brief target', async () => {
    const raw = '---\nid: T002\ntitle: Second\n---\n## Intent\nbody';
    reviewStore.setBriefSources(['first-brief-source', raw, 'third-brief-source']);
    reviewStore.setRenderedLineCount(3);
    reviewStore.setVisibleBriefCount(3);
    focusStore.set('brief', 1);

    const result = await build().copyTarget('brief');

    expect(readClipboardExecCalls().at(-1)?.stdin).toBe(raw);
    expect(result).toBe('native');
  });

  it('yanks the focused brief markdown via the inlined brief copy target (the y key path)', async () => {
    const raw = '---\nid: T001\ntitle: First\n---\n## Intent\nbody';
    reviewStore.setBriefSources([raw]);
    reviewStore.setRenderedLineCount(1);
    reviewStore.setVisibleBriefCount(1);
    focusStore.set('brief', 0);

    await build().copyTarget('brief');

    expect(readClipboardExecCalls().at(-1)?.stdin).toBe(raw);
  });

  it('falls back to the scroll-top brief for the brief target when no row is focused', async () => {
    reviewStore.setBriefSources(['only-brief']);
    reviewStore.setRenderedLineCount(1);
    reviewStore.setVisibleBriefCount(1);
    focusStore.clear();

    const result = await build().copyTarget('brief');

    expect(readClipboardExecCalls().at(-1)?.stdin).toBe('only-brief');
    expect(result).toBe('native');
  });

  it('reports empty for the brief target when sources exist but no row is rendered', async () => {
    reviewStore.setBriefSources(['hidden-brief']);
    reviewStore.setRenderedLineCount(1);
    reviewStore.setVisibleBriefCount(0);
    focusStore.clear();

    const result = await build().copyTarget('brief');

    expect(readClipboardExecCalls()).toHaveLength(0);
    expect(result).toBe('empty');
  });

  it('reports empty for the path target when paths exist but no row is rendered', async () => {
    reviewStore.setBriefPaths(['src/hidden.ts']);
    reviewStore.setRenderedLineCount(1);
    reviewStore.setVisibleBriefCount(0);
    focusStore.clear();

    const result = await build().copyTarget('path');

    expect(readClipboardExecCalls()).toHaveLength(0);
    expect(result).toBe('empty');
  });

  it('reports empty for the brief target when the focused index is out of range', async () => {
    reviewStore.setBriefSources(['only-one']);
    focusStore.set('brief', 5);

    const result = await build().copyTarget('brief');

    expect(readClipboardExecCalls()).toHaveLength(0);
    expect(result).toBe('empty');
  });

  it('copies the last assistant message raw for the default (message) target', async () => {
    const raw = 'first reply';
    const latest = 'final \u001b[31mreply\u001b[0m with controls';
    addEvent({ type: 'planner_text', ts: 1, phase: 'planning', text: raw, role: 'planner' });
    addEvent({ type: 'user_message', ts: 2, phase: 'planning', text: 'a user turn' });
    addEvent({ type: 'planner_text', ts: 3, phase: 'planning', text: latest, role: 'planner' });

    const result = await build().copyTarget('message');

    expect(readClipboardExecCalls().at(-1)?.stdin).toBe(latest);
    expect(result).toBe('native');
  });

  it('reports empty for the message target when no assistant message exists', async () => {
    const result = await build().copyTarget('message');

    expect(readClipboardExecCalls()).toHaveLength(0);
    expect(result).toBe('empty');
  });

  it('reports empty for the cost target when no priced usage has accrued', async () => {
    const result = await build().copyTarget('cost');

    expect(readClipboardExecCalls()).toHaveLength(0);
    expect(result).toBe('empty');
  });

  it('is not attached for an in-process session', () => {
    expect(build().isAttached).toBe(false);
  });

  it('reports an attached context when the workflow route carries an attach socket', () => {
    routerStore.init({
      screen: 'workflow',
      feature: 'feat',
      sessionId: 's1',
      attach: { sockPath: '/tmp/s.sock', authToken: 'tok' },
    });

    expect(build().isAttached).toBe(true);
  });

  it('hides local-only workflow mutation commands when attached', () => {
    routerStore.init({
      screen: 'workflow',
      feature: 'feat',
      sessionId: 's1',
      attach: { sockPath: '/tmp/s.sock', authToken: 'tok' },
    });

    const names = createRuntimeCommands(build()).map((cmd) => cmd.name);

    expect(names).not.toContain('/yolo');
    expect(names).not.toContain('/revise-spec');
    expect(names).not.toContain('/attach');
    expect(names).toContain('/copy');
  });

  it('refreshDetection applies fresh detection to stores without mutating config runner picks', async () => {
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
          planners: [
            {
              tool: 'claude-code',
              type: 'cli',
              available: true,
              version: `gen-${detectCalls}`,
            },
          ],
          implementers: [{ provider: 'ollama', available: true, isLocal: true }],
        };
      },
      fetchModelsDevCatalog: vi.fn().mockResolvedValue({}),
      discoverAllCliTools: vi.fn().mockResolvedValue({}),
    };

    await loadDetectionIntoStores(getDefaultDetectionService(), deps, detectionStore, projectDir);
    detectionStore.reset();
    expect(detectionStore.get().planners).toEqual([]);

    await build().refreshDetection();

    expect(detectionStore.get().planners[0]?.version).toBe('gen-2');
    expect(detectionStore.get().implementers[0]?.provider).toBe('ollama');
    expect(configStore.get().config?.planner).toEqual(config.planner);
    expect(configStore.get().config?.implementer.model).toBe(config.implementer.model);
  });

  it('routes workflow operations through the injected ports, not workflow feature internals', async () => {
    const calls: string[] = [];
    const fakePorts: WorkflowCommandPorts = {
      requestRewind: (request) => {
        calls.push(`rewind:${request.target}`);
        return true;
      },
      requestClearQueue: () => {
        calls.push('clearQueue');
        return { status: 'cleared', count: 7 };
      },
      findLatestActivityBatchKey: () => {
        calls.push('activityKey');
        return null;
      },
      readScrollMetrics: () => {
        calls.push('scrollMetrics');
        return { renderableCount: 0, totalHeight: 0, maxOffset: 0, viewportHeight: 10 };
      },
      resolveCopyValue: (target) => {
        calls.push(`copy:${target}`);
        return null;
      },
    };
    const ctx = buildCommandContext({ exit: () => {}, workflow: fakePorts });

    ctx.requestRewind('spec');
    ctx.requestTaskRedo('T-9');
    expect(ctx.clearQueue()).toEqual({ status: 'cleared', count: 7 });
    ctx.scrollConversation('bottom');
    ctx.toggleLatestActivityBatch();
    expect(await ctx.copyTarget('message')).toBe('empty');

    expect(calls).toEqual([
      'rewind:spec',
      'rewind:task',
      'clearQueue',
      'scrollMetrics',
      'activityKey',
      'copy:message',
    ]);
    expect(readClipboardExecCalls()).toHaveLength(0);
  });
});
