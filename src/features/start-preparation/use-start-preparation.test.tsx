import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { Composer } from '../../components/composer/composer.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import type { ReadinessReport } from '../../core/readiness/types.js';
import { readActive } from '../../core/sessions/lifecycle.js';
import {
  createSessionPreparationCandidate,
  prepareNewSession,
} from '../../core/sessions/prepare.js';
import { sessionDir } from '../../core/paths.js';
import type {
  PreparationOutcome,
  PreparedExecution,
} from '../../engine/runners/prepared-execution.js';
import { observePreparationCleanup } from './observe-cleanup.js';
import { useStartPreparation } from './use-start-preparation.js';

const OWNERSHIP_FILE = '.prepare-owner.json';
const ENTER = '\r';
const ESC = '\x1b';
const CTRL_U = '\x15';
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) cleanupTempDir(dir);
});

type Prepare = (input: string, signal: AbortSignal) => Promise<PreparationOutcome>;

type HarnessProps = Readonly<{
  prepare: Prepare;
  onPrepared: (execution: PreparedExecution) => void;
  onBack?: (() => void) | undefined;
  onEscape?: (() => void) | undefined;
  onAttempt?: ((promise: Promise<void>) => void) | undefined;
}>;

function Harness({ prepare, onPrepared, onBack, onEscape, onAttempt }: HarnessProps) {
  const controller = useStartPreparation<string>({
    prepare,
    onPrepared: (execution) => onPrepared(execution),
  });

  useInput((input, key) => {
    if (input === 's') {
      const promise = controller.submit('feature');
      onAttempt?.(promise);
      return;
    }
    if (input === 'r') {
      const promise = controller.retry();
      onAttempt?.(promise);
      return;
    }
    if (input === 'b') {
      controller.cancel(onBack);
      return;
    }
    if (key.escape) {
      controller.cancel(onEscape);
    }
  });

  return <Text>{controller.state.kind}</Text>;
}

// Mirrors the home wiring (src/app/screens/home.tsx): the composer clears its draft on
// every submit, so only the controller's republished draftRestore can put the text back.
// The submit counter is the settle signal — the composer bumps it in the same commit that
// clears the input, so a frame showing both the counter and the text is a restored one.
function ComposerHarness({ prepare }: Readonly<{ prepare: Prepare }>) {
  const [submits, setSubmits] = useState(0);
  const controller = useStartPreparation<string>({ prepare, onPrepared: () => {} });

  useInput((_input, key) => {
    if (key.escape) controller.cancel();
  });

  return (
    <Box flexDirection="column">
      <Text>{`${controller.state.kind} submits:${submits}`}</Text>
      <Composer
        commands={[]}
        currentScreen="home"
        mode="normal"
        hint=""
        onSubmit={(text) => {
          setSubmits((count) => count + 1);
          observePreparationCleanup(controller.submit(text));
        }}
        onRuntimeCommand={() => {}}
        draftRestore={controller.draftRestore}
      />
    </Box>
  );
}

function readinessReport(projectDir = '/project'): ReadinessReport {
  return {
    generatedAt: '2026-08-04T00:00:00.000Z',
    projectDir,
    status: 'ready',
    counts: { ok: 1, info: 0, warning: 0, blocker: 0 },
    nextAction: { kind: 'continue', label: 'Continue', reason: 'Tools are ready.' },
    sections: [],
    metadata: {},
  };
}

function blockedReport(): ReadinessReport {
  return {
    ...readinessReport(),
    status: 'blocked',
    counts: { ok: 0, info: 0, warning: 0, blocker: 1 },
    nextAction: { kind: 'exit', label: 'Exit', reason: 'Resolve the blocker.' },
  };
}

function prepared(id: string): Extract<PreparationOutcome, { kind: 'prepared' }> {
  const projectDir = createTempDir('start-preparation');
  tempDirs.push(projectDir);
  const config = makeConfig();
  const report = readinessReport(projectDir);
  const result = prepareNewSession({
    projectDir,
    feature: 'feature',
    config,
    report,
    candidate: createSessionPreparationCandidate({
      projectDir,
      feature: 'feature',
      persistTranscript: config.workflow.persistTranscript,
      sessionId: id,
    }),
  });
  if (result.kind === 'aborted') throw new Error('Session preparation unexpectedly aborted.');

  return {
    kind: 'prepared',
    execution: {
      purpose: 'new-workflow',
      config,
      preparationId: `preparation-${id}`,
      report,
      gates: [],
      session: {
        kind: 'new',
        ...result.session,
      },
      runtime: {
        feature: 'feature',
        allowRepoRunners: false,
        allowHooks: false,
      },
    },
  };
}

function ownedSession(outcome: Extract<PreparationOutcome, { kind: 'prepared' }>) {
  const session = outcome.execution.session;
  if (session.kind !== 'new') throw new Error('Expected a newly prepared session.');
  const directory = sessionDir(session.ref.projectDir, session.ref.sessionId);
  return {
    directory,
    marker: join(directory, OWNERSHIP_FILE),
    projectDir: session.ref.projectDir,
    sessionId: session.ref.sessionId,
  };
}

describe('useStartPreparation', () => {
  it('deduplicates submit and ignores an aborted stale completion', async () => {
    const pending = Promise.withResolvers<PreparationOutcome>();
    const signals: AbortSignal[] = [];
    const prepare = vi.fn<Prepare>((_input, signal) => {
      signals.push(signal);
      return pending.promise;
    });
    const onPrepared = vi.fn();
    const ui = renderFeature(<Harness prepare={prepare} onPrepared={onPrepared} />);

    await flushEffects();
    ui.stdin.write('s');
    await flushEffects();
    ui.stdin.write('s');
    await flushEffects();

    expect(prepare).toHaveBeenCalledOnce();
    expect(ui.lastFrame()).toContain('preparing');

    ui.stdin.write('b');
    await flushEffects();
    const stale = prepared('stale');
    const staleSession = ownedSession(stale);
    expect(existsSync(staleSession.directory)).toBe(true);
    expect(readActive(staleSession.projectDir)).toBe(staleSession.sessionId);
    pending.resolve(stale);
    await flushEffects();

    expect(signals[0]?.aborted).toBe(true);
    expect(existsSync(staleSession.directory)).toBe(false);
    expect(readActive(staleSession.projectDir)).toBeNull();
    expect(onPrepared).not.toHaveBeenCalled();
    expect(ui.lastFrame()).toContain('idle');
    ui.unmount();
  });

  it('Back aborts the pending attempt and suppresses its completion', async () => {
    const pending = Promise.withResolvers<PreparationOutcome>();
    let signal: AbortSignal | undefined;
    const onBack = vi.fn(() => expect(signal?.aborted).toBe(true));
    const onPrepared = vi.fn();
    const ui = renderFeature(
      <Harness
        prepare={async (_input, nextSignal) => {
          signal = nextSignal;
          return pending.promise;
        }}
        onPrepared={onPrepared}
        onBack={onBack}
      />,
    );

    await flushEffects();
    ui.stdin.write('s');
    await flushEffects();
    ui.stdin.write('b');
    await flushEffects();

    expect(signal?.aborted).toBe(true);
    expect(onBack).toHaveBeenCalledOnce();
    pending.resolve(prepared('back-stale'));
    await flushEffects();
    expect(onPrepared).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('Escape aborts the pending attempt and suppresses its completion', async () => {
    const pending = Promise.withResolvers<PreparationOutcome>();
    let signal: AbortSignal | undefined;
    const onEscape = vi.fn(() => expect(signal?.aborted).toBe(true));
    const onPrepared = vi.fn();
    const ui = renderFeature(
      <Harness
        prepare={async (_input, nextSignal) => {
          signal = nextSignal;
          return pending.promise;
        }}
        onPrepared={onPrepared}
        onEscape={onEscape}
      />,
    );

    await flushEffects();
    ui.stdin.write('s');
    await flushEffects();
    ui.stdin.write('\x1b');
    await flushEffects();

    expect(signal?.aborted).toBe(true);
    expect(onEscape).toHaveBeenCalledOnce();
    pending.resolve(prepared('escape-stale'));
    await flushEffects();
    expect(onPrepared).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('unmount aborts the pending attempt and suppresses its completion', async () => {
    const pending = Promise.withResolvers<PreparationOutcome>();
    let signal: AbortSignal | undefined;
    const onPrepared = vi.fn();
    const ui = renderFeature(
      <Harness
        prepare={async (_input, nextSignal) => {
          signal = nextSignal;
          return pending.promise;
        }}
        onPrepared={onPrepared}
      />,
    );

    await flushEffects();
    ui.stdin.write('s');
    await flushEffects();
    ui.unmount();

    expect(signal?.aborted).toBe(true);
    pending.resolve(prepared('unmount-stale'));
    await tick();
    expect(onPrepared).not.toHaveBeenCalled();
  });

  it('Retry starts a newer attempt and only the newer result wins', async () => {
    const first = Promise.withResolvers<PreparationOutcome>();
    const second = Promise.withResolvers<PreparationOutcome>();
    const requests = [first, second];
    const signals: AbortSignal[] = [];
    let requestIndex = 0;
    const prepare = vi.fn<Prepare>((_input, signal) => {
      signals.push(signal);
      const request = requests[requestIndex];
      requestIndex += 1;
      if (!request) throw new Error('Unexpected preparation attempt');
      return request.promise;
    });
    const onPrepared = vi.fn();
    const ui = renderFeature(<Harness prepare={prepare} onPrepared={onPrepared} />);

    await flushEffects();
    ui.stdin.write('s');
    await flushEffects();
    ui.stdin.write('r');
    await flushEffects();

    expect(prepare).toHaveBeenCalledTimes(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);

    second.resolve(prepared('newer'));
    await flushEffects();
    first.resolve(prepared('older'));
    await flushEffects();

    expect(onPrepared).toHaveBeenCalledOnce();
    expect(onPrepared.mock.calls[0]?.[0]).toMatchObject({ preparationId: 'preparation-newer' });

    ui.stdin.write('s');
    await flushEffects();
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(onPrepared).toHaveBeenCalledOnce();
    ui.unmount();
  });

  it('keeps blocked and failed attempts on the originating screen', async () => {
    const outcomes: PreparationOutcome[] = [
      { kind: 'blocked', report: blockedReport() },
      { kind: 'failed', report: blockedReport(), error: new Error('fresh check failed') },
    ];
    let outcomeIndex = 0;
    const onPrepared = vi.fn();
    const ui = renderFeature(
      <Harness
        prepare={async () => {
          const outcome = outcomes[outcomeIndex];
          outcomeIndex += 1;
          if (!outcome) throw new Error('Unexpected preparation attempt');
          return outcome;
        }}
        onPrepared={onPrepared}
      />,
    );

    await flushEffects();
    ui.stdin.write('s');
    await flushEffects();
    expect(ui.lastFrame()).toContain('blocked');

    ui.stdin.write('r');
    await flushEffects();
    expect(ui.lastFrame()).toContain('failed');
    expect(onPrepared).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('keeps the callbacks captured when a pending attempt started', async () => {
    const pending = Promise.withResolvers<PreparationOutcome>();
    const firstPrepare = vi.fn<Prepare>(() => pending.promise);
    const secondPrepare = vi.fn<Prepare>(async () => prepared('replacement'));
    const firstOnPrepared = vi.fn();
    const secondOnPrepared = vi.fn();
    const ui = renderFeature(<Harness prepare={firstPrepare} onPrepared={firstOnPrepared} />);

    await flushEffects();
    ui.stdin.write('s');
    ui.rerender(<Harness prepare={secondPrepare} onPrepared={secondOnPrepared} />);
    await flushEffects();

    expect(firstPrepare).toHaveBeenCalledOnce();
    expect(secondPrepare).not.toHaveBeenCalled();

    pending.resolve(prepared('captured'));
    await flushEffects();

    expect(firstOnPrepared).toHaveBeenCalledOnce();
    expect(firstOnPrepared.mock.calls[0]?.[0]).toMatchObject({
      preparationId: 'preparation-captured',
    });
    expect(secondOnPrepared).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('releases new-session ownership immediately before successful handoff', async () => {
    const outcome = prepared('handoff');
    const owned = ownedSession(outcome);
    let observedDuringHandoff: Readonly<{
      active: string | null;
      directory: boolean;
      marker: boolean;
    }> | null = null;
    const onPrepared = vi.fn(() => {
      observedDuringHandoff = {
        active: readActive(owned.projectDir),
        directory: existsSync(owned.directory),
        marker: existsSync(owned.marker),
      };
    });
    const ui = renderFeature(<Harness prepare={async () => outcome} onPrepared={onPrepared} />);

    await flushEffects();
    ui.stdin.write('s');
    await flushEffects();

    expect(observedDuringHandoff).toEqual({
      active: 'handoff',
      directory: true,
      marker: false,
    });
    expect(onPrepared).toHaveBeenCalledOnce();

    ui.stdin.write('s');
    await flushEffects();
    expect(onPrepared).toHaveBeenCalledOnce();
    expect(existsSync(owned.marker)).toBe(false);
    ui.unmount();
  });

  it('does not hand off when ownership cannot be released', async () => {
    const outcome = prepared('release-failure');
    const owned = ownedSession(outcome);
    rmSync(owned.marker);
    const onPrepared = vi.fn();
    const ui = renderFeature(<Harness prepare={async () => outcome} onPrepared={onPrepared} />);

    await flushEffects();
    ui.stdin.write('s');
    await flushEffects();

    expect(onPrepared).not.toHaveBeenCalled();
    expect(ui.lastFrame()).toContain('failed');
    expect(existsSync(owned.directory)).toBe(true);
    expect(readActive(owned.projectDir)).toBe(owned.sessionId);
    ui.unmount();
  });

  it('rejects a stale cleanup failure without overwriting the newer attempt', async () => {
    const first = Promise.withResolvers<PreparationOutcome>();
    const second = Promise.withResolvers<PreparationOutcome>();
    const requests = [first, second];
    const attempts: Promise<void>[] = [];
    let requestIndex = 0;
    const stale = prepared('stale-cleanup-failure');
    const owned = ownedSession(stale);
    rmSync(owned.marker);
    const ui = renderFeature(
      <Harness
        prepare={async () => {
          const request = requests[requestIndex];
          requestIndex += 1;
          if (!request) throw new Error('Unexpected preparation attempt');
          return request.promise;
        }}
        onPrepared={vi.fn()}
        onAttempt={(promise) => attempts.push(promise)}
      />,
    );

    await flushEffects();
    ui.stdin.write('s');
    await flushEffects();
    ui.stdin.write('r');
    await flushEffects();

    const staleAttempt = attempts[0];
    if (!staleAttempt) throw new Error('The stale attempt was not captured.');
    const cleanupFailure = expect(staleAttempt).rejects.toMatchObject({
      kind: 'session-prepare-io',
      data: { operation: 'rollback-session', sessionId: owned.sessionId },
    });
    first.resolve(stale);
    await cleanupFailure;
    await flushEffects();

    expect(ui.lastFrame()).toContain('preparing');
    expect(existsSync(owned.directory)).toBe(true);
    expect(readActive(owned.projectDir)).toBe(owned.sessionId);

    ui.stdin.write('b');
    second.resolve({ kind: 'aborted' });
    await flushEffects();
    ui.unmount();
  });
});

describe('useStartPreparation composer draft', () => {
  beforeEach(() => {
    resetAllStores();
    terminalSizeStore.__testReset({ cols: 80, rows: 24 });
  });

  it('keeps the draft in the composer across a repeat Enter and restores it on cancel', async () => {
    const pending = Promise.withResolvers<PreparationOutcome>();
    const prepare = vi.fn<Prepare>(() => pending.promise);
    const ui = renderFeature(<ComposerHarness prepare={prepare} />);
    const frame = () => stripAnsiStyles(ui.lastFrame());

    await flushEffects();
    ui.stdin.write('restore this draft');
    await vi.waitFor(() => expect(frame()).toContain('restore this draft'));

    ui.stdin.write(ENTER);
    await vi.waitFor(() => {
      expect(frame()).toContain('preparing submits:1');
      expect(frame()).toContain('restore this draft');
    });
    expect(prepare).toHaveBeenCalledOnce();

    ui.stdin.write(' plus a late edit');
    await vi.waitFor(() => expect(frame()).toContain('restore this draft plus a late edit'));

    ui.stdin.write(ENTER);
    await vi.waitFor(() => {
      expect(frame()).toContain('preparing submits:2');
      expect(frame()).toContain('restore this draft plus a late edit');
    });
    expect(prepare).toHaveBeenCalledOnce();

    ui.stdin.write(CTRL_U);
    await vi.waitFor(() => expect(frame()).not.toContain('restore this draft'));

    ui.stdin.write(ESC);
    await vi.waitFor(() => {
      expect(frame()).toContain('idle submits:2');
      expect(frame()).toContain('restore this draft');
    });
    ui.unmount();
  });
});
