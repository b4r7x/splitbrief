import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { Composer } from '../../components/composer/composer.js';
import {
  readActive,
  readActiveRecord,
  reactivateExistingSession,
  type ActiveSessionReceipt,
} from '../../core/sessions/active-pointer.js';
import type { ReadinessReport } from '../../core/readiness/types.js';
import {
  parsePreparedConfig,
  type PreparationOutcome,
  type PreparedExecution,
} from '../../engine/runners/prepared-execution.js';
import { terminalSizeStore } from '../ui/terminal-size.js';
import { preparationStore, type PreparationRequest } from './preparation.js';
import { routerStore } from './router.js';

const SESSION_ID = 'sess-prepare';
let projectDir = '';

beforeEach(() => {
  projectDir = createTempDir('preparation-test');
  preparationStore.reset();
});

afterEach(() => {
  preparationStore.reset();
  cleanupTempDir(projectDir);
});

const report = (): ReadinessReport => ({
  generatedAt: '2026-09-16T00:00:00.000Z',
  projectDir,
  status: 'ready',
  counts: { ok: 1, info: 0, warning: 0, blocker: 0 },
  nextAction: { kind: 'continue', label: 'Continue', reason: 'Ready' },
  sections: [],
  metadata: {},
});

function prepared(active: ActiveSessionReceipt) {
  const execution: PreparedExecution = {
    purpose: 'resume',
    config: parsePreparedConfig(makeConfig()),
    sourceConfig: parsePreparedConfig(makeConfig()),
    preparationId: `preparation-${active.generation}`,
    report: report(),
    gates: [],
    session: { kind: 'existing', ref: { projectDir, sessionId: SESSION_ID }, active },
    runtime: { feature: 'prepare', allowRepoRunners: false, allowHooks: false },
  };
  return { kind: 'prepared', execution } satisfies PreparationOutcome;
}

const claim = () => reactivateExistingSession({ projectDir, sessionId: SESSION_ID });

/** An attempt whose outcome the test settles by hand. */
function heldAttempt(origin: PreparationRequest['origin']) {
  const outcome = Promise.withResolvers<PreparationOutcome>();
  let signal: AbortSignal | undefined;
  const onPrepared = vi.fn<(execution: PreparedExecution) => void>();
  const onAbandoned = vi.fn();
  const handle = preparationStore.submit({
    origin,
    stage: 'Checking tools',
    prepare: (attemptSignal) => {
      signal = attemptSignal;
      return outcome.promise;
    },
    onPrepared,
    onAbandoned,
  });
  return { handle, outcome, onPrepared, onAbandoned, signal: () => signal };
}

describe('preparationStore', () => {
  it('rolls a prepared receipt back when navigation took its screen before handoff', async () => {
    const attempt = heldAttempt('start');
    await Promise.resolve();
    routerStore.navigate({ to: 'setup' });
    attempt.outcome.resolve(prepared(claim()));
    await attempt.handle.promise;

    expect(attempt.signal()?.aborted).toBe(true);
    expect(attempt.onPrepared).not.toHaveBeenCalled();
    expect(readActive(projectDir)).toBeNull();
    expect(preparationStore.get().kind).toBe('idle');
    expect(routerStore.get().screen).toBe('setup');
    routerStore.reset();
  });

  it('hands off only the newer attempt and rolls the superseded success back by its own receipt', async () => {
    const a = heldAttempt('start');
    const b = heldAttempt('continue');
    await flushEffects();

    expect(b.handle.attempt).toBeGreaterThan(a.handle.attempt);
    expect(a.signal()?.aborted).toBe(true);
    expect(a.onAbandoned).toHaveBeenCalledOnce();
    expect(b.signal()?.aborted).toBe(false);

    const receiptA = claim();
    const receiptB = claim();
    a.outcome.resolve(prepared(receiptA));
    await a.handle.promise;

    expect(a.onPrepared).not.toHaveBeenCalled();
    expect(readActiveRecord(projectDir)).toMatchObject({ kind: 'v1', receipt: receiptB });
    expect(preparationStore.get()).toMatchObject({
      kind: 'checking',
      attempt: b.handle.attempt,
      origin: 'continue',
    });

    const outcomeB = prepared(receiptB);
    b.outcome.resolve(outcomeB);
    await b.handle.promise;

    expect(b.onPrepared.mock.calls).toEqual([[outcomeB.execution]]);
    expect(preparationStore.get()).toEqual({ kind: 'idle' });
    expect(readActive(projectDir)).toBe(SESSION_ID);
  });

  it.each<[string, (a: ReturnType<typeof heldAttempt>) => void]>([
    ['fails', (a) => a.outcome.resolve({ kind: 'failed', error: new Error('A failed') })],
    ['rejects', (a) => a.outcome.reject(new Error('A rejected'))],
    ['blocks', (a) => a.outcome.resolve({ kind: 'blocked', report: report() })],
    ['aborts', (a) => a.outcome.resolve({ kind: 'aborted' })],
  ])('keeps the newer attempt current when the superseded one %s', async (_label, settleA) => {
    const a = heldAttempt('start');
    const b = heldAttempt('start');
    const current = preparationStore.get();

    settleA(a);
    await a.handle.promise;

    expect(preparationStore.get()).toBe(current);
    expect(preparationStore.cancel(a.handle.attempt)).toBe(false);
    expect(preparationStore.get()).toBe(current);
    expect(b.signal()?.aborted).toBe(false);

    b.outcome.resolve({ kind: 'blocked', report: report() });
    await b.handle.promise;
    expect(preparationStore.get()).toMatchObject({ kind: 'blocked', attempt: b.handle.attempt });
    expect(a.onPrepared).not.toHaveBeenCalled();
  });
});

describe('preparationStore while the composer is edited', () => {
  beforeEach(() => {
    resetAllStores();
    terminalSizeStore.__testReset({ cols: 80, rows: 24 });
  });

  it('typing and pasting never touch the attempt, and cancelling keeps the draft and grants nothing', async () => {
    const attempts: ReturnType<typeof heldAttempt>[] = [];
    const ui = renderFeature(
      createElement(Composer, {
        commands: [],
        currentScreen: 'home',
        mode: 'normal',
        hint: '',
        submitKeepsDraft: true,
        onRuntimeCommand: () => {},
        onSubmit: () => attempts.push(heldAttempt('start')),
      }),
    );
    const frame = () => stripAnsiStyles(ui.lastFrame());

    await flushEffects();
    ui.stdin.write('add a parser');
    await vi.waitFor(() => expect(frame()).toContain('add a parser'));
    ui.stdin.write('\r');
    await vi.waitFor(() => expect(preparationStore.get().kind).toBe('checking'));
    const checking = preparationStore.get();

    ui.stdin.write(' and tests');
    await vi.waitFor(() => expect(frame()).toContain('add a parser and tests'));
    ui.stdin.write('\none\ntwo\nthree\nfour');
    await vi.waitFor(() => expect(frame()).toContain('[paste #1 +5 lines]'));
    await flushEffects();
    const draft = frame();

    expect(preparationStore.get()).toBe(checking);
    expect(attempts).toHaveLength(1);
    const [attempt] = attempts;
    if (attempt === undefined) throw new Error('The submit did not start an attempt.');
    expect(preparationStore.cancel(attempt.handle.attempt)).toBe(true);
    await flushEffects();
    expect(frame()).toBe(draft);

    attempt.outcome.resolve(prepared(claim()));
    await attempt.handle.promise;

    expect(attempt.onPrepared).not.toHaveBeenCalled();
    expect(readActive(projectDir)).toBeNull();
    expect(preparationStore.get()).toEqual({ kind: 'idle' });
    ui.unmount();
  });
});
