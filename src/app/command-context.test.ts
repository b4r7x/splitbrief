import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { EngineEventOf } from '../engine/events/types.js';
import type { RewindTarget } from '../core/state/build-rewind-action.js';
import {
  setClearQueueHandler,
  setRewindHandler,
  clearAllHandlers,
} from '../features/workflow/handlers.js';
import { activityBatchKey } from '../features/workflow/conversation-rows/activity-batch-key.js';
import { configStore } from '../stores/project/config.js';
import { addEvent } from '../stores/workflow/actions.js';
import { conversationScrollStore } from '../stores/workflow/conversation-scroll.js';
import { controlsStore } from '../stores/ui/controls.js';
import { terminalSizeStore } from '../stores/ui/terminal-size.js';
import { buildCommandContext } from './command-context.js';

let projectDir = '';

afterEach(() => {
  clearAllHandlers();
  resetAllStores();
  if (projectDir) cleanupTempDir(projectDir);
  projectDir = '';
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

    const result = await buildCommandContext({ exit: () => {} }).rebuildRepomap();

    expect(result).toEqual({ deleted: true, files: [cacheFile] });
    expect(existsSync(cacheFile)).toBe(false);
  });

  it('delegates queue clearing to the live workflow handler', () => {
    setClearQueueHandler(() => ({ status: 'cleared', count: 2 }));

    expect(buildCommandContext({ exit: () => {} }).clearQueue()).toEqual({
      status: 'cleared',
      count: 2,
    });
  });

  it('routes rewind requests to the live workflow handler', () => {
    const requests: RewindTarget[] = [];
    setRewindHandler((request) => requests.push(request));

    buildCommandContext({ exit: () => {} }).requestRewind('spec', 'redo');

    expect(requests).toEqual([{ target: 'spec', comment: 'redo' }]);
  });

  it('routes task redo through the live rewind handler', () => {
    const requests: RewindTarget[] = [];
    setRewindHandler((request) => requests.push(request));

    buildCommandContext({ exit: () => {} }).requestTaskRedo('T-1');

    expect(requests).toEqual([{ target: 'task', taskId: 'T-1' }]);
  });

  it('scrolls the conversation to the bottom through the conversation scroll store', () => {
    conversationScrollStore.__testReset({ scrollOffset: 5 });

    const result = buildCommandContext({ exit: () => {} }).scrollConversation('bottom');

    expect(result).toEqual({ status: 'scrolled' });
    expect(conversationScrollStore.get().scrollOffset).toBe(0);
  });

  it('toggles the latest expandable activity batch through the conversation scroll store', () => {
    const key = seedExpandableActivityBatch();

    const result = buildCommandContext({ exit: () => {} }).toggleLatestActivityBatch();

    expect(result).toEqual({ status: 'toggled', expanded: true });
    expect(conversationScrollStore.get().expandedActivityBatches.has(key)).toBe(true);
  });

  it('toggles the workflow sidebar through the controls store', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    const ctx = buildCommandContext({ exit: () => {} });

    expect(ctx.toggleSidebar()).toEqual({ status: 'toggled', visible: true });
    expect(controlsStore.get().sidebarVisible).toBe(true);
    expect(ctx.toggleSidebar()).toEqual({ status: 'toggled', visible: false });
    expect(controlsStore.get().sidebarVisible).toBe(false);
  });

  it('does not report the workflow sidebar as shown on small terminals', () => {
    terminalSizeStore.__testReset({ cols: 60, rows: 24, isSmall: true });

    expect(buildCommandContext({ exit: () => {} }).toggleSidebar()).toEqual({
      status: 'unavailable',
      message: 'Sidebar is hidden on small terminals.',
    });
    expect(controlsStore.get().sidebarVisible).toBe(false);
  });
});
