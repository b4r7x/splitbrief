import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRpcCommandContext } from './command-context.js';
import { createEventBus } from '../../engine/events/bus.js';
import { createJsonlSink } from '../../engine/events/sinks/jsonl.js';
import {
  createDefaultConfig,
  loadConfig,
  writeConfig as writeProjectConfig,
} from '../../core/config/load/io.js';
import type { Config } from '../../core/schemas/config.js';
import type { EngineEvent } from '../../engine/events/types.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { SESSION_LOG_FILE, sessionDir } from '../../core/paths.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { SessionLogEventEntrySchema } from '../../core/schemas/session-log.js';
import { loadState } from '../../core/state/persistence.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../core/transcript-policy.js';
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

  it('reports UI-only conversation commands as unavailable', () => {
    const ctx = makeRpcContext(() => createDefaultConfig());

    expect(ctx.scrollConversation('top')).toEqual({
      status: 'unavailable',
      message: 'Conversation scrolling is not available in RPC mode.',
    });
    expect(ctx.toggleLatestActivityBatch()).toEqual({
      status: 'unavailable',
      message: 'Activity expansion is not available in RPC mode.',
    });
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

    it('does not write one-shot invocation overrides back when saving a durable command edit', () => {
      let persisted: Config | null = createDefaultConfig();
      writeProjectConfig(projectDir, persisted);
      let effective: Config | null = {
        ...persisted,
        implementer: { ...persisted.implementer, model: 'one-shot-rpc-model' },
      };
      const ctx = createRpcCommandContext({
        projectDir,
        getSessionId: () => undefined,
        getState: () => null,
        getConfig: () => effective,
        getPersistedConfig: () => persisted,
        setConfig: (config) => {
          effective = config;
        },
        setPersistedConfig: (config) => {
          persisted = config;
        },
        getPhase: () => 'implementing',
        queueHandler: () => null,
        clearQueueHandler: () => null,
        abort: () => {},
        bus: createEventBus(),
        messages: [],
        errors: [],
        pendingQueueDepth: () => 0,
      });

      const ok = ctx.setWorkflowMode('speckit');

      const diskConfig = loadConfig(projectDir).config;
      expect(ok).toBe(true);
      expect(effective?.workflow.mode).toBe('speckit');
      expect(persisted?.workflow.mode).toBe('speckit');
      expect(diskConfig.workflow.mode).toBe('speckit');
      expect(diskConfig.implementer.model).not.toBe('one-shot-rpc-model');
    });

    it('keeps RPC yolo approval state session-local instead of persisting config', () => {
      let persisted: Config | null = createDefaultConfig();
      writeProjectConfig(projectDir, persisted);
      let effective: Config | null = persisted;
      const ctx = createRpcCommandContext({
        projectDir,
        getSessionId: () => undefined,
        getState: () => null,
        getConfig: () => effective,
        getPersistedConfig: () => persisted,
        setConfig: (config) => {
          effective = config;
        },
        setPersistedConfig: (config) => {
          persisted = config;
        },
        getPhase: () => 'implementing',
        queueHandler: () => null,
        clearQueueHandler: () => null,
        abort: () => {},
        bus: createEventBus(),
        messages: [],
        errors: [],
        pendingQueueDepth: () => 0,
      });

      ctx.setApprovalEnabled(false);

      expect(ctx.getApprovalEnabled()).toBe(false);
      expect(effective?.approval?.enabled).toBe(false);
      expect(loadConfig(projectDir).config.approval?.enabled).not.toBe(false);
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

    function makeRewindContext(
      state: WorkflowState,
      overrides: {
        config?: Config;
        setRewindFeedback?: (feedback: string | undefined) => void;
      } = {},
    ) {
      const config = overrides.config ?? createDefaultConfig();
      const published: EngineEvent[] = [];
      const bus = createEventBus();
      bus.subscribe((event) => published.push(event));
      bus.subscribe(
        createJsonlSink({
          projectDir,
          sessionId,
          persistTranscript: config.workflow.persistTranscript,
        }),
      );
      const ctx = createRpcCommandContext({
        projectDir,
        getSessionId: () => sessionId,
        getState: () => state,
        getConfig: () => config,
        setConfig: () => {},
        getPhase: () => state.phase,
        queueHandler: () => null,
        clearQueueHandler: () => null,
        abort: () => {},
        bus,
        ...(overrides.setRewindFeedback !== undefined && {
          setRewindFeedback: overrides.setRewindFeedback,
        }),
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

    it('keeps transcript-off RPC rewind feedback transient while persisting protected state', () => {
      const state = makeImplState([makeTask()]);
      const rawFeedback = 'redo the spec with private deployment detail';
      const config = createDefaultConfig();
      config.workflow.persistTranscript = false;
      const setRewindFeedback = vi.fn();
      const { ctx, published } = makeRewindContext(state, { config, setRewindFeedback });

      const ok = ctx.requestRewind('spec', rawFeedback);

      expect(ok).toBe(true);
      expect(setRewindFeedback).toHaveBeenCalledWith(rawFeedback);
      expect(published).toEqual([
        expect.objectContaining({
          type: 'rewind_to_spec',
          comment: TRANSCRIPT_OMITTED_MESSAGE,
        }),
      ]);
      expect(readSessionEvents()).toEqual([
        expect.objectContaining({
          type: 'rewind_to_spec',
          data: { comment: TRANSCRIPT_OMITTED_MESSAGE },
        }),
      ]);
      const saved = loadState({ projectDir, sessionId });
      expect(saved?.rewindPending).toEqual({
        target: 'spec',
        comment: TRANSCRIPT_OMITTED_MESSAGE,
      });
      expect(JSON.stringify(saved)).not.toContain(rawFeedback);
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
