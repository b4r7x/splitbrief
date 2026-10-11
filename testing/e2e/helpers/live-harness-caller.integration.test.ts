import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reviewPacketJsonPath } from '../../../src/core/paths.js';
import { saveState } from '../../../src/core/state/persistence.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeReviewPacket } from '#testing/helpers/factories/review-packet.js';
import { makeSummary, makeUsage } from '#testing/helpers/factories/summary.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { MATRIX_TIERS, type ReleaseMatrixRun, runReleaseMatrixRow } from './live-harness.js';

const mocks = vi.hoisted(() => ({
  detect: vi.fn<typeof import('../../../src/engine/detection/detect.js').detectAvailableCliTools>(),
  prepare:
    vi.fn<
      typeof import('../../../src/engine/runners/prepare-execution/prepare-execution.js').prepareExecution
    >(),
  workflow: vi.fn<typeof import('../../../src/engine/orchestrator/run/workflow.js').runWorkflow>(),
  apply: vi.fn<typeof import('../../../src/engine/orchestrator/apply/run.js').runApply>(),
  evaluate: vi.fn<typeof import('./artifact-assertions.js').evaluateTsArtifact>(),
}));

vi.mock('../../../src/engine/detection/detect.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/engine/detection/detect.js')>()),
  detectAvailableCliTools: mocks.detect,
}));
vi.mock('../../../src/engine/runners/prepare-execution/prepare-execution.js', () => ({
  prepareExecution: mocks.prepare,
}));
vi.mock('../../../src/engine/orchestrator/run/workflow.js', () => ({
  runWorkflow: mocks.workflow,
}));
vi.mock('../../../src/engine/orchestrator/apply/run.js', () => ({ runApply: mocks.apply }));
vi.mock('./artifact-assertions.js', () => ({ evaluateTsArtifact: mocks.evaluate }));

const originalCwd = process.cwd();
let root: string;
const order: string[] = [];
const run: ReleaseMatrixRun = {
  id: 'caller-row',
  tier: 'one-file',
  task: MATRIX_TIERS['one-file'].task,
  plan: { tool: 'codex', model: 'pin' },
  build: { tool: 'codex', model: 'pin' },
};

beforeEach(() => {
  root = createTempDir('live-row-caller');
  process.chdir(root);
  vi.stubEnv('SPLITBRIEF_REAL_CLI_E2E', '1');
  vi.stubEnv('SPLITBRIEF_LIVE_SKIP', '');
  mocks.detect.mockResolvedValue([
    cliDetectionFor('ready', 'codex'),
    cliDetectionFor('ready', 'codex'),
  ]);
  mocks.prepare.mockImplementation(async (input) => {
    if (!('projectDir' in input)) throw new Error('expected a new workflow preparation');
    return {
      kind: 'prepared',
      execution: makePreparedExecution({
        projectDir: input.projectDir,
        sessionId: 'caller-session',
        feature: input.feature,
        config: input.effectiveConfig,
      }),
    };
  });
});

afterEach(() => {
  process.chdir(originalCwd);
  cleanupTempDir(root);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  order.length = 0;
});

describe('release matrix row caller', () => {
  it('waits for an aborted workflow to settle before starting the next row', async () => {
    vi.useFakeTimers();
    let probes = 0;
    mocks.detect.mockImplementation(async () => {
      order.push(`probe ${++probes}`);
      return [cliDetectionFor('ready', 'codex'), cliDetectionFor('ready', 'codex')];
    });
    mocks.workflow.mockImplementationOnce(async ({ signal }) => {
      if (signal === undefined) throw new Error('workflow has no row signal');
      order.push('first workflow');
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            order.push('first aborted');
            setTimeout(resolve, 1_000);
          },
          { once: true },
        );
      });
      order.push('first settled');
      return makeSummary();
    });
    mocks.workflow.mockImplementationOnce(async () => {
      order.push('second workflow');
      throw new Error('second workflow finished');
    });
    const first = runReleaseMatrixRow(run, 30_000);
    let firstSettled = false;
    const firstRejected = expect(
      first.finally(() => {
        firstSettled = true;
      }),
    ).rejects.toThrow('Live row timed out after 20000ms.');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(order).toEqual(['probe 1', 'first workflow', 'first aborted']);
    expect(firstSettled).toBe(false);
    const second = runReleaseMatrixRow({ ...run, id: 'second-row' }, 30_000);
    const secondRejected = expect(second).rejects.toThrow('second workflow finished');
    await vi.advanceTimersByTimeAsync(999);
    expect(order).toEqual(['probe 1', 'first workflow', 'first aborted']);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([firstRejected, secondRejected]);
    expect(order).toEqual([
      'probe 1',
      'first workflow',
      'first aborted',
      'first settled',
      'probe 2',
      'second workflow',
    ]);
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.evaluate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('applies the workflow artifact before evaluating it', async () => {
    const artifact = MATRIX_TIERS[run.tier].artifact;
    const content = 'export const liveEasy = "live-easy";\n';
    mocks.workflow.mockImplementation(async ({ prepared }) => {
      order.push('workflow');
      const ref = prepared.session.ref;
      expect(existsSync(join(ref.projectDir, artifact.path))).toBe(false);
      saveState(
        ref,
        makeWorkflowState({
          phase: 'complete',
          reviewStatus: 'passed',
          tasks: [makeTask({ status: 'done', suggestedFiles: [artifact.path] })],
          tokenUsage: makeUsage({ plannerInput: 1, implementerInput: 1 }),
          workspace: {
            kind: 'staged-copy',
            path: join(ref.projectDir, 'workspace'),
            base: { snapshotId: 'baseline', head: null },
          },
        }),
      );
      writeFileSync(
        reviewPacketJsonPath(ref),
        JSON.stringify(makeReviewPacket({ sessionId: ref.sessionId })),
      );
      return makeSummary();
    });
    mocks.apply.mockImplementation(async ({ wctx, state }) => {
      order.push('apply');
      const path = join(wctx.projectDir, artifact.path);
      expect(existsSync(path)).toBe(false);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      return {
        outcome: 'applied',
        files: [artifact.path],
        state: { ...state, closed: { as: 'applied', at: new Date().toISOString() } },
      };
    });
    mocks.evaluate.mockImplementation((path, accessor) => {
      order.push('evaluation');
      expect(accessor).toBe(artifact.accessor);
      expect(readFileSync(path, 'utf-8')).toBe(content);
      return artifact.expected;
    });

    await expect(runReleaseMatrixRow(run, 30_000)).resolves.toEqual({ outcome: 'pass' });
    expect(order).toEqual(['workflow', 'apply', 'evaluation']);
    expect(
      JSON.parse(readFileSync(join(root, '.test-artifacts/live/manifest.json'), 'utf-8')).rows,
    ).toMatchObject([{ outcome: 'pass' }]);
  });
});
