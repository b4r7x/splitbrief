import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRpcCommandContext } from './command-context.js';
import { createEventBus } from '../../engine/events/bus.js';
import { createJsonlSink } from '../../engine/events/sinks/jsonl.js';
import { createDefaultConfig, loadConfig } from '../../core/config/load/io.js';
import type { Config } from '../../core/schemas/config.js';
import type { EngineEvent } from '../../engine/events/types.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { SESSION_LOG_FILE, sessionDir } from '../../core/paths.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { SessionLogEventEntrySchema } from '../../core/schemas/session-log.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

function makeRpcContext(
  getConfig: () => ReturnType<typeof createDefaultConfig> | null,
  overrides: { projectDir?: string; setConfig?: (config: Config) => void } = {},
) {
  return createRpcCommandContext({
    projectDir: overrides.projectDir ?? '/tmp/proj',
    getSessionId: () => undefined,
    getState: () => null,
    getConfig,
    setConfig: overrides.setConfig ?? (() => {}),
    getPhase: () => 'implementing',
    queueHandler: () => null,
    clearQueueHandler: () => null,
    abort: () => {},
    bus: createEventBus(),
    messages: [],
    errors: [],
    pendingQueueDepth: () => 0,
  });
}

describe('createRpcCommandContext', () => {
  it('reports a session-specific error for session-requiring commands without a session', () => {
    const ctx = makeRpcContext(() => createDefaultConfig());
    expect(() => ctx.acceptRunSnapshot()).toThrow(/No active session/);
  });

  it('reports a config-specific error (not the session error) when config is absent', () => {
    const ctx = makeRpcContext(() => null);
    expect(() => ctx.compactTranscript()).toThrow(/No config loaded/);
  });

  describe('config persistence', () => {
    let projectDir: string;

    beforeEach(() => {
      projectDir = createTempDir('rpc-command-context');
    });

    afterEach(() => {
      cleanupTempDir(projectDir);
    });

    it('persists config-mutating commands to disk', () => {
      let inMemory: Config | null = createDefaultConfig();
      const ctx = makeRpcContext(() => inMemory, {
        projectDir,
        setConfig: (config) => {
          inMemory = config;
        },
      });

      const ok = ctx.setWorkflowMode('speckit');

      expect(ok).toBe(true);
      expect(loadConfig(projectDir).config.workflow.mode).toBe('speckit');
      expect(inMemory?.workflow.mode).toBe('speckit');
    });
  });

  describe('rewind publishing', () => {
    let projectDir: string;
    const sessionId = 'sess-1';

    beforeEach(() => {
      projectDir = createTempDir('rpc-command-context-rewind');
      ensureSessionDir(projectDir, sessionId);
    });

    afterEach(() => {
      cleanupTempDir(projectDir);
    });

    function makeRewindContext(state: WorkflowState) {
      const published: EngineEvent[] = [];
      const bus = createEventBus();
      bus.subscribe((event) => published.push(event));
      bus.subscribe(createJsonlSink({ projectDir, sessionId, persistTranscript: true }));
      const ctx = createRpcCommandContext({
        projectDir,
        getSessionId: () => sessionId,
        getState: () => state,
        getConfig: () => createDefaultConfig(),
        setConfig: () => {},
        getPhase: () => state.phase,
        queueHandler: () => null,
        clearQueueHandler: () => null,
        abort: () => {},
        bus,
        messages: [],
        errors: [],
        pendingQueueDepth: () => 0,
      });
      return { ctx, published };
    }

    function readSessionEvents() {
      return readFileSync(join(sessionDir(projectDir, sessionId), SESSION_LOG_FILE), 'utf-8')
        .trim()
        .split('\n')
        .map((line) => SessionLogEventEntrySchema.parse(JSON.parse(line)));
    }

    it('publishes a rewind_to_spec event on the bus and persists it to the ledger exactly once', () => {
      const state = makeImplState([makeTask()]);
      const { ctx, published } = makeRewindContext(state);

      const ok = ctx.requestRewind('spec', 'redo the spec');

      expect(ok).toBe(true);
      expect(published).toEqual([
        expect.objectContaining({ type: 'rewind_to_spec', comment: 'redo the spec' }),
      ]);
      expect(readSessionEvents()).toEqual([
        expect.objectContaining({ type: 'rewind_to_spec', data: { comment: 'redo the spec' } }),
      ]);
    });

    it('publishes a task_reset event on the bus and persists it to the ledger exactly once', () => {
      const state = makeImplState([makeTask({ id: 'T001' })]);
      const { ctx, published } = makeRewindContext(state);

      const ok = ctx.requestTaskRedo('T001');

      expect(ok).toBe(true);
      expect(published).toEqual([expect.objectContaining({ type: 'task_reset', taskId: 'T001' })]);
      expect(readSessionEvents()).toEqual([
        expect.objectContaining({ type: 'task_reset', taskId: 'T001' }),
      ]);
    });
  });
});
