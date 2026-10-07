import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { CONFIG_FILE, SPLITBRIEF_DIR } from '../../../core/paths.js';
import { writeConfig } from '../../../core/config/load/io.js';
import { saveState } from '../../../core/state/persistence.js';
import type { PreparationPolicy } from '../../runners/prepare-execution/types.js';
import type { prepareExecution } from '../../runners/prepare-execution/prepare-execution.js';
import type { EngineEvent } from '../../events/types.js';
import type { PreparedExecution } from '../../runners/prepared-execution.js';
import { applyOfferedSeatSwap, type SeatSwapChoice } from './seat-swap.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

const RESUME_POLICY: Extract<PreparationPolicy, { purpose: 'resume' }> = {
  purpose: 'resume',
  interaction: 'headless',
  allowRepoRunners: false,
  allowHooks: false,
  unverifiedAuth: 'denied',
};

const CHOICE: SeatSwapChoice = {
  candidate: { tool: 'claude-code' },
  policy: RESUME_POLICY,
};

function setup(name: string, offered: boolean) {
  const projectDir = createTempDir(name);
  dirs.push(projectDir);
  const sessionId = `sess-${name}`;
  ensureSessionDir(projectDir, sessionId);
  const task = makeTask({ id: 'T001' });
  const savedState = makeImplState([task], {
    pendingRecovery: makeRecoveryIssue({
      reason: 'runner-usage-limit',
      taskId: task.id,
      affectedTaskIds: [task.id],
      availableActions: offered
        ? ['retry-same-worker', 'switch-seat', 'skip-current-task', 'end-run']
        : ['retry-same-worker', 'skip-current-task', 'end-run'],
      recommendedAction: offered ? 'switch-seat' : 'retry-same-worker',
      ...(offered && { switchSeat: { seat: 'build', candidates: [{ tool: 'claude-code' }] } }),
    }),
  });
  saveState({ projectDir, sessionId }, savedState);
  const config = makeConfig({ implementer: { kind: 'cli', tool: 'codex' } });
  writeConfig(projectDir, config);
  return { projectDir, sessionId, savedState, config };
}

function preparedFor(config: ReturnType<typeof makeConfig>): PreparedExecution {
  return { config, purpose: 'resume' } as unknown as PreparedExecution;
}

function warningMessages(events: readonly EngineEvent[]): string[] {
  return events.flatMap((event) => (event.type === 'warning' ? [event.message] : []));
}

describe('applyOfferedSeatSwap', () => {
  it('does nothing when the operator chose nothing', async () => {
    const { projectDir, sessionId, savedState, config } = setup('seat-swap-none', true);
    const { bus } = makeBusRecorder();

    const outcome = await applyOfferedSeatSwap({
      choice: undefined,
      projectDir,
      sessionId,
      bus,
      config,
      prepared: preparedFor(config),
      savedState,
    });

    expect(outcome).toBeUndefined();
  });

  it('does nothing when the halt carried no offer', async () => {
    const { projectDir, sessionId, savedState, config } = setup('seat-swap-unoffered', false);
    const { bus } = makeBusRecorder();

    const outcome = await applyOfferedSeatSwap({
      choice: CHOICE,
      projectDir,
      sessionId,
      bus,
      config,
      prepared: preparedFor(config),
      savedState,
    });

    expect(outcome).toBeUndefined();
  });

  it('hands back the re-prepared execution the switched seat was admitted under', async () => {
    const { projectDir, sessionId, savedState, config } = setup('seat-swap-prepared', true);
    const { bus } = makeBusRecorder();
    const switchedConfig = makeConfig({ implementer: { kind: 'cli', tool: 'claude-code' } });
    const execution = preparedFor(switchedConfig);
    const prepare = vi.fn(
      async () => ({ kind: 'prepared', execution }) as const,
    ) as unknown as typeof prepareExecution;

    const swappedTo: PreparedExecution[] = [];

    const outcome = await applyOfferedSeatSwap({
      choice: CHOICE,
      projectDir,
      sessionId,
      bus,
      config,
      prepared: preparedFor(config),
      savedState,
      prepare,
      onSeatSwapped: (swappedPrepared) => swappedTo.push(swappedPrepared),
    });

    expect(outcome?.prepared).toBe(execution);
    expect(outcome?.config).toBe(switchedConfig);
    expect(outcome?.state.pendingRecovery).toBeUndefined();
    // The caller that runs the workflow again re-runs on the admitted preparation.
    expect(swappedTo).toEqual([execution]);
  });

  it('keeps the run on its previous seat and names admission when the swap is blocked', async () => {
    const { projectDir, sessionId, savedState, config } = setup('seat-swap-blocked', true);
    const { bus, events } = makeBusRecorder();
    const prepared = preparedFor(config);
    const prepare = vi.fn(
      async () => ({ kind: 'blocked', report: {} }) as const,
    ) as unknown as typeof prepareExecution;

    const outcome = await applyOfferedSeatSwap({
      choice: CHOICE,
      projectDir,
      sessionId,
      bus,
      config,
      prepared,
      savedState,
      prepare,
    });

    expect(outcome?.prepared).toBe(prepared);
    // Nothing was written, so the halt stays pending and the run stops on it again.
    expect(outcome?.state.pendingRecovery).toBeDefined();
    expect(warningMessages(events)).toEqual([
      "The build seat was not switched to 'claude-code': it could not be admitted; the halt stays.",
    ]);
  });

  it('names the error when re-preparing the switched seat failed', async () => {
    const { projectDir, sessionId, savedState, config } = setup('seat-swap-failed', true);
    const { bus, events } = makeBusRecorder();
    const prepared = preparedFor(config);
    const prepare = vi.fn(
      async () => ({ kind: 'failed', error: new Error('hook trust refused') }) as const,
    ) as unknown as typeof prepareExecution;

    const outcome = await applyOfferedSeatSwap({
      choice: CHOICE,
      projectDir,
      sessionId,
      bus,
      config,
      prepared,
      savedState,
      prepare,
    });

    expect(outcome?.prepared).toBe(prepared);
    expect(outcome?.state.pendingRecovery).toBeDefined();
    expect(warningMessages(events)[0]).toContain('preparing it failed: hook trust refused');
  });

  it('warns about nothing when the operator cancelled the re-preparation', async () => {
    const { projectDir, sessionId, savedState, config } = setup('seat-swap-aborted', true);
    const { bus, events } = makeBusRecorder();
    const prepared = preparedFor(config);
    const prepare = vi.fn(
      async () => ({ kind: 'aborted' }) as const,
    ) as unknown as typeof prepareExecution;

    const outcome = await applyOfferedSeatSwap({
      choice: CHOICE,
      projectDir,
      sessionId,
      bus,
      config,
      prepared,
      savedState,
      prepare,
    });

    expect(outcome?.prepared).toBe(prepared);
    expect(outcome?.state.pendingRecovery).toBeDefined();
    expect(warningMessages(events)).toEqual([]);
  });

  it('keeps the halt with one row when the config changed underneath the write', async () => {
    const { projectDir, sessionId, savedState, config } = setup('seat-swap-conflict', true);
    const { bus, events } = makeBusRecorder();
    const prepared = preparedFor(config);
    // The operator edits the file while the seat is being prepared, so the revision
    // the halt read no longer matches when the writer checks it.
    const prepare = vi.fn(async () => {
      const file = join(projectDir, SPLITBRIEF_DIR, CONFIG_FILE);
      writeFileSync(file, `${readFileSync(file, 'utf8')}\n`);
      return { kind: 'prepared', execution: preparedFor(config) } as const;
    }) as unknown as typeof prepareExecution;

    const outcome = await applyOfferedSeatSwap({
      choice: CHOICE,
      projectDir,
      sessionId,
      bus,
      config,
      prepared,
      savedState,
      prepare,
    });

    expect(outcome?.prepared).toBe(prepared);
    expect(outcome?.state.pendingRecovery).toBeDefined();
    expect(warningMessages(events)).toEqual(['config changed meanwhile · the halt stays']);
  });
});
