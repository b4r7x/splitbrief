import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  sessionDir,
  DRIFT_REPORT_FILE,
  EVIDENCE_FILE,
  REVIEW_FILE,
  SESSION_LOG_FILE,
  SUMMARY_FILE,
  TASKS_FILE,
} from '../../../src/core/paths.js';
import { saveState } from '../../../src/core/state/persistence.js';
import { createJsonlSink } from '../../../src/engine/events/sinks/jsonl.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { resolveReleaseMatrixSeat } from '../live/matrix.js';
import {
  liveRunFailureReason,
  recordLiveMatrixRun,
  runLiveRowWithDeadline,
} from './live-harness.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('live matrix default pins', () => {
  it('resolves OpenCode and Antigravity defaults without model discovery', () => {
    vi.stubEnv('PATH', '');
    vi.stubEnv('SPLITBRIEF_REAL_CLI_OPENCODE_MODEL', undefined);
    vi.stubEnv('SPLITBRIEF_REAL_CLI_ANTIGRAVITY_MODEL', undefined);
    expect(resolveReleaseMatrixSeat('opencode').model).toBe('opencode-go/deepseek-v4.1-flash');
    expect(resolveReleaseMatrixSeat('antigravity').model).toBe('gemini-3.8-flash-low');
  });

  it('keeps env overrides and the cost ceiling for both defaults', () => {
    vi.stubEnv('SPLITBRIEF_REAL_CLI_OPENCODE_MODEL', 'opencode-go/deepseek-v4-flash');
    vi.stubEnv('SPLITBRIEF_REAL_CLI_ANTIGRAVITY_MODEL', 'gemini-3.8-flash-high');
    expect(resolveReleaseMatrixSeat('opencode').model).toBe('opencode-go/deepseek-v4-flash');
    expect(resolveReleaseMatrixSeat('antigravity').model).toBe('gemini-3.8-flash-high');
    vi.stubEnv('SPLITBRIEF_REAL_CLI_ANTIGRAVITY_MODEL', 'claude-opus');
    expect(() => resolveReleaseMatrixSeat('antigravity')).toThrow(/cost ceiling/);
  });
});

describe('live failure evidence', () => {
  const errorEvent = (message: string) => ({
    type: 'error' as const,
    phase: 'planning' as const,
    ts: 1,
    message,
  });

  it('reports a halt before an error event, then the saved failure or last error', () => {
    const issue = makeRecoveryIssue({
      reason: 'planner-call-failed',
      message: 'Planner call failed',
      details: ['CLI exited 1: signed out'],
    });
    expect(
      liveRunFailureReason({
        state: makeWorkflowState({ pendingRecovery: issue }),
        events: [errorEvent('old error')],
      }),
    ).toContain('planner-call-failed: Planner call failed\nCLI exited 1: signed out');
    expect(
      liveRunFailureReason({
        state: makeWorkflowState({
          lastFailure: {
            step: { kind: 'planner', call: 'plan' },
            message: 'transport broke',
            at: new Date().toISOString(),
          },
        }),
        events: [],
      }),
    ).toBe('transport broke');
    expect(
      liveRunFailureReason({ state: null, events: [errorEvent('first'), errorEvent('last')] }),
    ).toBe('last');
    expect(liveRunFailureReason({ state: null, events: [] })).toBeNull();
  });

  it.each(['pass', 'assertion failure', 'workflow rejection'])(
    'keeps artifacts after the project is removed: %s',
    async (outcome) => {
      await withTempDir('live-row-evidence', async (root) => {
        const projectDir = join(root, 'project');
        const ref = { projectDir, sessionId: 'test-session' };
        const dir = sessionDir(projectDir, ref.sessionId);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, SUMMARY_FILE), 'saved summary');
        const otherArtifacts = [TASKS_FILE, EVIDENCE_FILE, DRIFT_REPORT_FILE, REVIEW_FILE];
        for (const file of otherArtifacts) writeFileSync(join(dir, file), `saved ${file}`);
        const issue = makeRecoveryIssue({
          reason: 'planner-call-failed',
          message: 'Planner call failed',
          details: ['CLI exited 1: signed out'],
        });
        if (outcome !== 'pass')
          saveState(ref, makeWorkflowState({ phase: 'planning', pendingRecovery: issue }));
        createJsonlSink(ref)(errorEvent('CLI exited 1: signed out'));
        const artifactsRoot = join(root, 'artifacts');
        const result = recordLiveMatrixRun({
          projectDir,
          root: artifactsRoot,
          startedAt: Date.now(),
          row: {
            id: 'test-row',
            tier: 'one-file',
            plan: { tool: 'codex', model: 'pin' },
            build: { tool: 'codex', model: 'pin' },
          },
          run: async (onSession) => {
            onSession(ref.sessionId);
            if (outcome !== 'pass') throw new Error(outcome);
            return makeSummary();
          },
        });
        if (outcome === 'pass') await result;
        else await expect(result).rejects.toThrow(/planner-call-failed.*Planner call failed/);
        rmSync(projectDir, { recursive: true });
        expect(readFileSync(join(artifactsRoot, 'test-row', SUMMARY_FILE), 'utf-8')).toBe(
          'saved summary',
        );
        expect(readFileSync(join(artifactsRoot, 'test-row', SESSION_LOG_FILE), 'utf-8')).toContain(
          'CLI exited 1: signed out',
        );
        for (const file of otherArtifacts)
          expect(readFileSync(join(artifactsRoot, 'test-row', file), 'utf-8')).toBe(
            `saved ${file}`,
          );
        const manifest = JSON.parse(readFileSync(join(artifactsRoot, 'manifest.json'), 'utf-8'));
        expect(manifest.rows).toHaveLength(1);
        expect(manifest.rows[0].outcome).toBe(outcome === 'pass' ? 'pass' : 'fail');
        expect(manifest.rows[0].artifacts.sessionLog).toBe(
          join(artifactsRoot, 'test-row', SESSION_LOG_FILE),
        );
        if (outcome !== 'pass') {
          expect(manifest.rows[0].reason).toContain(outcome);
          expect(manifest.rows[0].reason).toContain('CLI exited 1: signed out');
        }
      });
    },
  );

  it('records preparation failure before a session exists', async () => {
    await withTempDir('live-preparation-failure', async (root) => {
      await expect(
        recordLiveMatrixRun({
          projectDir: root,
          root,
          startedAt: Date.now(),
          row: {
            id: 'unprepared',
            plan: { tool: 'codex', model: 'pin' },
            build: { tool: 'codex', model: 'pin' },
          },
          run: async () => {
            throw new Error('preparation failed');
          },
        }),
      ).rejects.toThrow('preparation failed');
      const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf-8'));
      expect(manifest.rows).toHaveLength(1);
      expect(manifest.rows[0]).toMatchObject({ outcome: 'fail', reason: 'preparation failed' });
      expect(manifest.rows[0].artifacts).toBeUndefined();
    });
  });
});

describe('live row deadline', () => {
  it('aborts before Vitest, awaits settlement and prevents the next row from overlapping', async () => {
    vi.useFakeTimers();
    let settle: (() => void) | undefined;
    let firstSignal: AbortSignal | undefined;
    const order: string[] = [];
    const first = runLiveRowWithDeadline({
      timeoutMs: 30_000,
      run: async (signal) => {
        firstSignal = signal;
        order.push('first started');
        await new Promise<void>((resolve) => {
          settle = resolve;
        });
        order.push('first settled');
      },
    });
    const firstRejected = expect(first).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(firstSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(firstSignal?.aborted).toBe(true);
    const second = runLiveRowWithDeadline({
      timeoutMs: 30_000,
      run: async () => {
        order.push('second started');
      },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(order).toEqual(['first started']);
    if (settle === undefined) throw new Error('first row did not start');
    settle();
    await firstRejected;
    await second;
    expect(order).toEqual(['first started', 'first settled', 'second started']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears deadlines on success and rejection and lets later rows run', async () => {
    vi.useFakeTimers();
    await expect(runLiveRowWithDeadline({ timeoutMs: 300_000, run: async () => 42 })).resolves.toBe(
      42,
    );
    await expect(
      runLiveRowWithDeadline({
        timeoutMs: 900_000,
        run: async () => {
          throw new Error('runner failed');
        },
      }),
    ).rejects.toThrow('runner failed');
    await expect(
      runLiveRowWithDeadline({ timeoutMs: 300_000, run: async () => 'next' }),
    ).resolves.toBe('next');
    expect(vi.getTimerCount()).toBe(0);
  });
});
