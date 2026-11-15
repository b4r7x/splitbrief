import { afterEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { setupProject } from '#testing/helpers/state-ops.js';
import { CODEX_LIMIT_MESSAGE } from '#testing/helpers/usage-limit-fixtures.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { revertedDir } from '../../../core/paths.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { transition } from '../../../core/state/machine.js';
import { loadState } from '../../../core/state/persistence.js';
import { createEventBus } from '../../events/bus.js';
import type { EngineEvent } from '../../events/types.js';
import type { RunnerFailureOutcomeState } from '../../runners/errors.js';
import { buildSeatHalt, raiseSeatHalt } from './halts.js';

const projectDirs: string[] = [];

afterEach(() => {
  for (const dir of projectDirs.splice(0)) cleanupTempDir(dir);
});

function setup(overrides?: Partial<WorkflowState>) {
  const { projectDir, sessionId } = setupProject();
  projectDirs.push(projectDir);
  const bus = createEventBus();
  const events: EngineEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const config = makeConfig({ implementer: { kind: 'cli', tool: 'codex', model: 'gpt-5.5' } });
  const task = makeTask({ id: 'T001' });
  // One call of the brief is already on its lineage.
  const state = transition(makeImplState([task], overrides), {
    type: 'COUNT_ATTEMPT',
    taskId: task.id,
  });
  return { scope: { projectDir, sessionId, bus, config }, task, state, events };
}

async function halt(
  outcome: RunnerFailureOutcomeState,
  toolMessage: string,
  opts: { booked?: boolean; state?: Partial<WorkflowState> } = {},
) {
  const { scope, task, state, events } = setup(opts.state);
  const built = await buildSeatHalt(scope, state, task, {
    outcome,
    runner: scope.config.implementer,
    toolMessage,
    booked: opts.booked ?? false,
  });
  return { scope, task, state, events, built };
}

function errorRows(events: EngineEvent[]) {
  return events.flatMap((event) => (event.type === 'error' ? [event] : []));
}

describe('the halt of a failed BUILD seat call', () => {
  it('halts a signed-out seat as seat down on the attempt that failed and parks the brief', async () => {
    const { scope, task, state, events, built } = await halt(
      'unauthenticated',
      'HTTP 401 Unauthorized',
    );

    expect(built?.issue).toMatchObject({ reason: 'runner-unauthenticated', taskId: 'T001' });
    expect(built?.issue.details).toContain('Attempts: 2');
    expect(built?.issue.resetAt).toBeUndefined();
    expect(events).toEqual([]);

    const next = raiseSeatHalt(scope, state, task, built!);

    const [row] = errorRows(events);
    expect(row?.message).toContain('HTTP 401 Unauthorized');
    expect(row?.message.startsWith(built!.issue.message)).toBe(true);
    expect(row?.resetAt).toBeUndefined();
    expect(next.pendingRecovery).toEqual(built?.issue);
    expect(next.interruptedStep).toMatchObject({
      step: { kind: 'brief', taskId: 'T001' },
      source: 'seat',
      cut: 'mid-step',
    });
    expect(loadState(scope)?.pendingRecovery?.reason).toBe('runner-unauthenticated');
  });

  it('carries the reset of a usage limit on the halt and on its error row, spelled once', async () => {
    const { scope, task, state, events, built } = await halt('usage-limit', CODEX_LIMIT_MESSAGE);

    expect(built?.issue.reason).toBe('runner-usage-limit');
    expect(new Date(built?.issue.resetAt ?? '')).toEqual(new Date(2026, 7, 8, 15, 27));

    raiseSeatHalt(scope, state, task, built!);

    const [row] = errorRows(events);
    expect(row?.resetAt).toBe(built?.issue.resetAt);
    expect(row?.message).toContain(
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits.",
    );
    expect(row?.message).not.toMatch(/3:27 PM|15:27/);
  });

  it('halts a runner defect with its own message and puts back the attempt of a checkout run', async () => {
    const { scope, task, state, events, built } = await halt(
      'checkout-changed',
      'HEAD moved from abc123 to def456',
      {
        state: {
          workspace: { kind: 'checkout', path: '/repo', base: { snapshotId: 's1', head: null } },
        },
      },
    );

    expect(built?.issue.reason).toBe('checkout-changed');
    expect(built?.issue.details).toEqual(
      expect.arrayContaining([expect.stringContaining(revertedDir(scope))]),
    );

    const next = raiseSeatHalt(scope, state, task, built!);

    expect(errorRows(events).map((row) => row.message)).toEqual([built?.issue.message]);
    expect(next.pendingRecovery?.reason).toBe('checkout-changed');
    expect(next.interruptedStep).toBeUndefined();
  });

  it('counts a call the lineage booked before the halt once', async () => {
    const booked = await halt('runner-timeout-repeated', 'codex timed out', { booked: true });
    const unbooked = await halt('runner-timeout-repeated', 'codex timed out');

    expect(booked.built?.issue.reason).toBe('runner-timeout-repeated');
    expect(booked.built?.issue.details).toContain('Attempts: 1');
    expect(unbooked.built?.issue.details).toContain('Attempts: 2');
  });

  it('raises no halt for an outcome a retry can still fix', async () => {
    const { built, events } = await halt('timeout', 'codex timed out');

    expect(built).toBeUndefined();
    expect(events).toEqual([]);
  });
});
