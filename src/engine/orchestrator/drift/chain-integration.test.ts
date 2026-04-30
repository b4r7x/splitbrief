import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'node:child_process';
import { createEventBus } from '../../events/bus.js';
import type { EngineEvent, EventBus } from '../../events/types.js';
import {
  readDriftChainState,
  writeDriftChainState,
  initialDriftChainState,
} from './chain-state.js';
import { computePerTaskOutOfBounds, analyzeDriftChain } from './chain.js';
import { publishWarning } from '../events.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext } from '../types.js';

const mockedExecSync = vi.mocked(execSync);

function makeWorkflowState(): WorkflowState {
  return {
    version: 3,
    phase: 'implementing',
    feature: 'test-feature',
    tasks: [],
    currentTaskIndex: 0,
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 },
    implementerTool: 'ollama',
    implementerModel: 'qwen2.5',
    plannerTool: 'claude-code',
  } as unknown as WorkflowState;
}

function makeBusRecorder(): { bus: EventBus; events: EngineEvent[] } {
  const events: EngineEvent[] = [];
  const bus = createEventBus();
  bus.subscribe((e) => events.push(e));
  return { bus, events };
}

function makeWctx(projectDir: string, sessionId: string, bus: EventBus, threshold?: number): WorkflowContext {
  return {
    projectDir,
    sessionId,
    config: makeConfig({
      workflow: {
        commitStrategy: 'none',
        maxRetries: 0,
        ...(threshold !== undefined ? { driftChainThreshold: threshold } : {}),
      },
    }),
    bus,
    callbacks: {
      onApprovalNeeded: vi.fn().mockResolvedValue({ approved: true }),

      onComplete: vi.fn(),
    },
    planner: {} as WorkflowContext['planner'],
    implementer: {} as WorkflowContext['implementer'],
    context: { name: 'proj', dir: projectDir, runtime: 'Node.js 22', testCommand: 'npm test' },
    metadata: { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' },
    sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
    validator: { runValidation: vi.fn() } as unknown as WorkflowContext['validator'],
  };
}

/**
 * Mirrors the logic of the private runChainAnalysisSafe function in task-step.ts.
 * Tests verify the observable side-effects (drift-chains.json written, warning events published).
 */
async function runChainAnalysis(opts: {
  wctx: WorkflowContext;
  task: ReturnType<typeof makeTask>;
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  taskStartRef: string;
  bus: EventBus;
}): Promise<void> {
  try {
    let taskChangedFiles: string[];
    try {
      const out = (execSync as typeof import('node:child_process').execSync)(
        `git diff --name-only ${opts.taskStartRef}`,
        { cwd: opts.projectDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim();
      taskChangedFiles = out.length === 0 ? [] : out.split('\n').map((f: string) => f.trim()).filter(Boolean);
    } catch {
      taskChangedFiles = [];
    }

    const outOfBoundsFiles = computePerTaskOutOfBounds(opts.task, taskChangedFiles);
    const existing = readDriftChainState(opts.projectDir, opts.sessionId)
      ?? initialDriftChainState(opts.sessionId);
    const threshold = opts.wctx.config.workflow.driftChainThreshold ?? 0.6;
    const update = analyzeDriftChain(existing, opts.task.id, outOfBoundsFiles, threshold);
    writeDriftChainState(opts.projectDir, opts.sessionId, update.state);
  } catch (err) {
    const { toErrorMessage } = await import('../../../utils/format-errors.js');
    publishWarning(opts.bus, opts.state.phase, `drift chain analysis failed: ${toErrorMessage(err)}`);
  }
}

describe('drift-chain integration', () => {
  let projectDir: string;
  let sessionId: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'drift-chain-int-'));
    sessionId = 'sess-int-test';
    mkdirSync(join(projectDir, '.diptych', 'sessions', sessionId), { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('after task completes locally with out-of-bounds files → drift-chains.json is written', async () => {
    mockedExecSync.mockReturnValue('src/extra.ts\n' as unknown as string);

    const { bus } = makeBusRecorder();
    const task = makeTask({ id: 'T001', file: 'src/main.ts' });
    const wctx = makeWctx(projectDir, sessionId, bus);
    const state = makeWorkflowState();

    await runChainAnalysis({ wctx, task, projectDir, sessionId, state, taskStartRef: 'abc123', bus });

    const written = readDriftChainState(projectDir, sessionId);
    expect(written).not.toBeNull();
    expect(written?.activeChain.entries).toHaveLength(1);
    expect(written?.activeChain.entries[0]?.taskId).toBe('T001');
    expect(written?.activeChain.uniqueFiles).toContain('src/extra.ts');
  });

  it('after task completes cleanly (no out-of-bounds) → active chain reset in drift-chains.json', async () => {
    const existing = initialDriftChainState(sessionId);
    writeDriftChainState(projectDir, sessionId, {
      ...existing,
      activeChain: {
        entries: [{ taskId: 'T000', outOfBoundsFiles: ['src/other.ts'] }],
        uniqueFiles: ['src/other.ts'],
        score: 0.2,
      },
    });

    mockedExecSync.mockReturnValue('src/main.ts\n' as unknown as string);

    const { bus } = makeBusRecorder();
    const task = makeTask({ id: 'T001', file: 'src/main.ts' });
    const wctx = makeWctx(projectDir, sessionId, bus);
    const state = makeWorkflowState();

    await runChainAnalysis({ wctx, task, projectDir, sessionId, state, taskStartRef: 'abc123', bus });

    const written = readDriftChainState(projectDir, sessionId);
    expect(written?.activeChain.entries).toHaveLength(0);
    expect(written?.activeChain.score).toBe(0);
  });

  it('does NOT throw when git is unavailable (execSync throws)', async () => {
    mockedExecSync.mockImplementation(() => { throw new Error('git not found'); });

    const { bus, events } = makeBusRecorder();
    const task = makeTask({ file: 'src/main.ts' });
    const wctx = makeWctx(projectDir, sessionId, bus);
    const state = makeWorkflowState();

    await expect(
      runChainAnalysis({ wctx, task, projectDir, sessionId, state, taskStartRef: 'HEAD', bus }),
    ).resolves.toBeUndefined();

    const errorEvents = events.filter(e => e.type === 'error');
    expect(errorEvents).toHaveLength(0);
  });

  it('warning event published when chain analysis fails internally', async () => {
    const { bus, events } = makeBusRecorder();
    const state = makeWorkflowState();

    // Block writeDriftChainState by making the session directory path exist as a FILE
    // (so ensureSecureDir / writeFileSync fails on a path-is-not-dir error)
    const { writeFileSync } = await import('node:fs');
    const sessionDirPath = join(projectDir, '.diptych', 'sessions', sessionId);
    // Remove the dir we created in beforeEach and replace with a file
    rmSync(sessionDirPath, { recursive: true, force: true });
    writeFileSync(sessionDirPath, 'block');

    mockedExecSync.mockReturnValue('src/extra.ts\n' as unknown as string);

    const task = makeTask({ file: 'src/main.ts' });
    const wctx = makeWctx(projectDir, sessionId, bus);

    await runChainAnalysis({ wctx, task, projectDir, sessionId, state, taskStartRef: 'abc123', bus });

    const warningEvents = events.filter(e => e.type === 'warning') as Array<{ type: 'warning'; message: string }>;
    expect(warningEvents).toHaveLength(1);
    expect(warningEvents[0]?.message).toContain('drift chain analysis failed');
  });
});
