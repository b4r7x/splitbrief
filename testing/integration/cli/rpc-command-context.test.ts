import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRpcCommandContext } from '../../../src/cli/rpc/command-context.js';
import {
  resolveRunConfigWithBase,
  type ResolvedRunConfig,
} from '../../../src/cli/build-overrides.js';
import { createEventBus } from '../../../src/engine/events/bus.js';
import { createJsonlSink } from '../../../src/engine/events/sinks/jsonl.js';
import {
  createDefaultConfig,
  loadConfig,
  writeConfig as writeProjectConfig,
} from '../../../src/core/config/load/io.js';
import type { Config } from '../../../src/core/schemas/config.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import type { WorkflowOpts } from '../../../src/core/types/config-options.js';
import { SESSION_LOG_FILE, sessionDir } from '../../../src/core/paths.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import { SessionLogEventEntrySchema } from '../../../src/core/schemas/session-log.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../../src/core/transcript-policy.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

function createMutableRpcContext(args: {
  projectDir?: string;
  opts?: WorkflowOpts;
  initial?: ResolvedRunConfig | null;
  getSessionId?: () => string | undefined;
  getState?: () => WorkflowState | null;
  bus?: ReturnType<typeof createEventBus>;
  setRewindFeedback?: (feedback: string | undefined) => void;
}) {
  const projectDir = args.projectDir ?? process.cwd();
  const opts = args.opts ?? {};
  let runConfig =
    args.initial === undefined ? resolveRunConfigWithBase({ projectDir, opts }) : args.initial;
  const context = createRpcCommandContext({
    projectDir,
    getSessionId: args.getSessionId ?? (() => undefined),
    getState: args.getState ?? (() => null),
    getRunConfig: () => runConfig,
    setRunConfig: (next) => {
      runConfig = next;
    },
    reloadRunConfig: () => resolveRunConfigWithBase({ projectDir, opts }),
    setEffectiveConfig: (config) => {
      if (runConfig) runConfig = { ...runConfig, config };
    },
    getPhase: () => 'implementing',
    queueHandler: () => null,
    clearQueueHandler: () => null,
    abort: () => {},
    bus: args.bus ?? createEventBus(),
    ...(args.setRewindFeedback !== undefined && {
      setRewindFeedback: args.setRewindFeedback,
    }),
    messages: [],
    errors: [],
    pendingQueueDepth: () => 0,
  });
  return { context, getRunConfig: () => runConfig };
}

describe('createRpcCommandContext integration', () => {
  it('reports a session-specific error for session-requiring commands without a session', () => {
    const { context: ctx } = createMutableRpcContext({});
    expect(() => ctx.acceptRunSnapshot()).toThrow(/No active session/);
  });

  it('reports a config-specific error (not the session error) when config is absent', () => {
    const { context: ctx } = createMutableRpcContext({ initial: null });
    expect(() => ctx.compactTranscript()).toThrow(/No config loaded/);
  });

  it('reports UI-only conversation commands as unavailable', () => {
    const { context: ctx } = createMutableRpcContext({});

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

    it('publishes the refreshed config snapshot after a saved command mutation', async () => {
      const rpc = createMutableRpcContext({ projectDir });
      const before = rpc.getRunConfig()?.persistenceSnapshot.revision;

      const result = await rpc.context.setWorkflowMode('speckit');

      expect(result.kind).toBe('saved');
      expect(loadConfig(projectDir).config.workflow.mode).toBe('speckit');
      expect(rpc.getRunConfig()?.config.workflow.mode).toBe('speckit');
      expect(rpc.getRunConfig()?.persistedConfig.workflow.mode).toBe('speckit');
      expect(rpc.getRunConfig()?.persistenceSnapshot.rawYaml).toContain('mode: speckit');
      expect(rpc.getRunConfig()?.persistenceSnapshot.revision).not.toBe(before);
    });

    it('does not write one-shot invocation overrides back when saving a durable command edit', async () => {
      writeProjectConfig(projectDir, createDefaultConfig());
      const rpc = createMutableRpcContext({
        projectDir,
        opts: { model: 'one-shot-rpc-model' },
      });

      const result = await rpc.context.setWorkflowMode('speckit');

      const diskConfig = loadConfig(projectDir).config;
      expect(result.kind).toBe('saved');
      expect(rpc.getRunConfig()?.config.workflow.mode).toBe('speckit');
      expect(rpc.getRunConfig()?.persistedConfig.workflow.mode).toBe('speckit');
      expect(diskConfig.workflow.mode).toBe('speckit');
      expect(diskConfig.implementer.model).not.toBe('one-shot-rpc-model');
    });

    it('rejects a stale RPC config edit without changing in-memory config or external bytes', async () => {
      writeProjectConfig(projectDir, createDefaultConfig());
      const rpc = createMutableRpcContext({ projectDir });
      const external = loadConfig(projectDir).config;
      writeProjectConfig(projectDir, {
        ...external,
        workflow: { ...external.workflow, mode: 'quick' },
      });
      const externalBytes = readFileSync(join(projectDir, '.splitbrief', 'config.yaml'), 'utf8');

      const result = await rpc.context.setWorkflowMode('speckit');

      expect(result.kind).toBe('conflict');
      expect(rpc.getRunConfig()?.config.workflow.mode).toBe('standard');
      expect(rpc.getRunConfig()?.persistedConfig.workflow.mode).toBe('standard');
      expect(loadConfig(projectDir).config.workflow.mode).toBe('quick');
      expect(readFileSync(join(projectDir, '.splitbrief', 'config.yaml'), 'utf8')).toBe(
        externalBytes,
      );
    });

    it('keeps RPC yolo approval state session-local instead of persisting config', () => {
      writeProjectConfig(projectDir, createDefaultConfig());
      const rpc = createMutableRpcContext({ projectDir });

      rpc.context.setApprovalEnabled(false);

      expect(rpc.context.getApprovalEnabled()).toBe(false);
      expect(rpc.getRunConfig()?.config.approval?.enabled).toBe(false);
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
      const initial = resolveRunConfigWithBase({ projectDir, opts: {} });
      const rpc = createMutableRpcContext({
        projectDir,
        getSessionId: () => sessionId,
        getState: () => state,
        initial: { ...initial, config, persistedConfig: config },
        bus,
        ...(overrides.setRewindFeedback !== undefined && {
          setRewindFeedback: overrides.setRewindFeedback,
        }),
      });
      return { ctx: rpc.context, published };
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
