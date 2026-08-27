import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRpcCommandContext } from '../../../src/cli/rpc/command-context.js';
import {
  resolveRunConfigWithBase,
  type ResolvedRunConfig,
} from '../../../src/cli/build-overrides.js';
import { createEventBus } from '../../../src/engine/events/bus.js';
import {
  createDefaultConfig,
  loadConfig,
  writeConfig as writeProjectConfig,
} from '../../../src/core/config/load/io.js';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import type { WorkflowOpts } from '../../../src/core/types/config-options.js';
import type { PreparedExecution } from '../../../src/engine/runners/prepared-execution.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

function createMutableRpcContext(args: {
  projectDir?: string;
  opts?: WorkflowOpts;
  initial?: ResolvedRunConfig | null;
  getPreparedExecution?: () => PreparedExecution | null;
  getSessionId?: () => string | undefined;
  getState?: () => WorkflowState | null;
  bus?: ReturnType<typeof createEventBus>;
  requestRewind?: (request: { target: 'spec' | 'plan'; comment?: string }) => boolean;
  requestTaskRedo?: (taskId: string) => boolean;
}) {
  const projectDir = args.projectDir ?? process.cwd();
  const opts = args.opts ?? {};
  let runConfig =
    args.initial === undefined ? resolveRunConfigWithBase({ projectDir, opts }) : args.initial;
  const context = createRpcCommandContext({
    projectDir,
    getPreparedExecution: args.getPreparedExecution ?? (() => null),
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
    ...(args.requestRewind !== undefined && { requestRewind: args.requestRewind }),
    ...(args.requestTaskRedo !== undefined && { requestTaskRedo: args.requestTaskRedo }),
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

  it('reports that no prepared execution exists when transcript compaction has no authority', () => {
    const { context: ctx } = createMutableRpcContext({ initial: null });
    expect(() => ctx.compactTranscript()).toThrow(/No active session/);
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

  describe('live recovery callbacks', () => {
    it('forwards rewind requests to the live workflow callback', () => {
      const requestRewind = vi.fn(() => true);
      const rpc = createMutableRpcContext({ requestRewind });

      expect(rpc.context.requestRewind('spec', 'redo the spec')).toBe(true);
      expect(requestRewind).toHaveBeenCalledWith({ target: 'spec', comment: 'redo the spec' });
    });

    it('forwards task redo requests to the live workflow callback', () => {
      const requestTaskRedo = vi.fn(() => true);
      const rpc = createMutableRpcContext({ requestTaskRedo });

      expect(rpc.context.requestTaskRedo('T001')).toBe(true);
      expect(requestTaskRedo).toHaveBeenCalledWith('T001');
    });

    it('reports a typed unavailable error when no live recovery callback exists', () => {
      const rpc = createMutableRpcContext({});

      expect(() => rpc.context.requestRewind('spec')).toThrow(
        'RPC rewind is unavailable without a live workflow.',
      );
      expect(() => rpc.context.requestTaskRedo('T001')).toThrow(
        'RPC task redo is unavailable without a live workflow.',
      );
    });
  });
});
