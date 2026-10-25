import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { ApprovalReviewResult } from '../../core/approval/types.js';
import { CREW_SEAT_IDS, CREW_SEAT_LABELS, type CrewSeatId } from '../../core/crew/identity.js';
import type { Config } from '../../core/schemas/config.js';
import type { RecoveryIssue } from '../../core/schemas/recovery/schemas.js';
import { reactivateExistingSession } from '../../core/sessions/active-pointer.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { loadState, saveState } from '../../core/state/persistence.js';
import { seatIdentitiesFromConfig, writeSeatIdentities } from '../../core/state/seats.js';
import { configStore } from '../../stores/project/config.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { pickerViewStore } from '../../stores/ui/picker-view.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { recoveryNoticeStore } from '../../stores/workflow/recovery-notice.js';
import { Header } from './components/header.js';
import { plainAnswer, type UseInputModeResult } from './hooks/use-input-mode.js';
import { createRecoveryDriver } from './recovery-driver.js';
import { addTuiEvent } from './tui-sink.js';

const CLAUDE = { kind: 'cli', tool: 'claude-code', model: 'claude-3-5-sonnet' } as const;
const CODEX = { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' } as const;
const CODEX_O3 = { kind: 'cli', tool: 'codex', model: 'o3' } as const;
const CODEX_LOW = { ...CODEX, effort: 'low' } as const;
const OLLAMA = {
  kind: 'api',
  provider: 'ollama',
  model: 'qwen2.5-coder:7b',
  apiBase: 'http://localhost:11434/v1',
} as const;
const RESET_ISO = '2026-07-16T17:00:00.000Z';

type Seat = typeof CLAUDE | typeof CODEX | typeof CODEX_O3 | typeof CODEX_LOW | typeof OLLAMA;

/** A crew of Claude seats with one seat moved. */
function crewWith(seatId: CrewSeatId, seat: Seat): Config {
  const crew = { planner: CLAUDE, implementer: CLAUDE, reviewer: CLAUDE };
  if (seatId === 'build') return makeConfig({ ...crew, implementer: seat });
  if (seat.kind === 'api') throw new Error('the plan and review seats here are CLI seats');
  return makeConfig(seatId === 'plan' ? { ...crew, planner: seat } : { ...crew, reviewer: seat });
}

let dirs: string[] = [];

beforeEach(() => {
  resetAllStores();
  terminalSizeStore.__testReset({ cols: 200, rows: 40, isSmall: false });
});

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
  resetAllStores();
});

function save(config: Config): void {
  configStore.__testReset({ projectDir: '/tmp/project', config });
}

async function seatLine(): Promise<string> {
  const ui = renderFeature(<Header />);
  await tick();
  const frame = stripAnsiStyles(ui.lastFrame() ?? '');
  ui.unmount();
  return frame.split('\n').find((line) => line.includes('BUILD')) ?? frame;
}

/** Whether the seat's own segment of the header line carries the reset note. */
function noteOn(line: string, seatId: CrewSeatId): boolean {
  return new RegExp(`${CREW_SEAT_LABELS[seatId]} [^·]*\\(resets`).test(line);
}

function usageHalt(seatId: CrewSeatId, overrides: Partial<RecoveryIssue> = {}): RecoveryIssue {
  return makeRecoveryIssue({
    reason: 'runner-usage-limit',
    seat: seatId,
    resetAt: RESET_ISO,
    facts: { tool: 'OpenAI Codex CLI', cause: 'rate-limit' },
    availableActions: ['retry-same-worker', 'retry-later', 'end-run'],
    recommendedAction: 'retry-later',
    ...(seatId !== 'build' && { phase: 'final-review', taskId: undefined }),
    ...overrides,
  });
}

/**
 * Opens a halt through the recovery driver the way the run loop does, and reads the header line
 * when the panel opens and again after each seat saved while it waits. `ran` is the crew the
 * halted pass started on; `configOfRun` is the config the run was prepared from (a run reopened
 * at rest is prepared from the config saved since).
 */
async function haltFrames(input: {
  ran: Config;
  issue: RecoveryIssue;
  savedAtOpen?: Config | undefined;
  configOfRun?: Config | undefined;
  whileOpen?: readonly Config[] | undefined;
}): Promise<string[]> {
  const projectDir = createTempDir('reset-note');
  dirs.push(projectDir);
  const sessionId = 'sess-reset-note';
  const ref = { projectDir, sessionId };
  ensureSessionDir(projectDir, sessionId);
  writeSeatIdentities(ref, seatIdentitiesFromConfig(input.ran));
  saveState(
    ref,
    makeImplState([makeTask({ id: 'T001', status: 'failed' })], { pendingRecovery: input.issue }),
  );
  const state = loadState(ref);
  if (state === null) throw new Error('expected the halted state to persist');
  save(input.savedAtOpen ?? input.ran);
  const prepared = makePreparedExecution({
    projectDir,
    sessionId,
    feature: 'reset note',
    config: input.configOfRun ?? input.ran,
    resumeState: state,
    active: reactivateExistingSession(ref),
  });
  const frames: string[] = [];
  const inputMode: UseInputModeResult = {
    mode: 'question',
    hint: '',
    questionEpoch: 0,
    setReviewMode: async (): Promise<ApprovalReviewResult> => ({ approved: false }),
    setQuestionMode: async () => {
      frames.push(await seatLine());
      for (const config of input.whileOpen ?? []) {
        save(config);
        frames.push(await seatLine());
      }
      return plainAnswer('end-run');
    },
    resolve: () => {},
    resetMode: () => {},
  };
  await createRecoveryDriver({
    prepared,
    configOfRun: prepared.sourceConfig,
    inputMode,
    abortedRef: { current: false },
    retentionNoticeHandled: { current: true },
    sink: addTuiEvent,
    setInlineResume: () => {},
  })({ state, controller: new AbortController(), republishPrompt: false });
  return frames;
}

describe.each(CREW_SEAT_IDS)('the reset note on the %s seat', (seatId) => {
  it('sits on the seat that halted while no other seat is saved', async () => {
    const ran = crewWith(seatId, CODEX);
    const [atOpen] = await haltFrames({ ran, issue: usageHalt(seatId) });

    expect(noteOn(atOpen ?? '', seatId)).toBe(true);
  });

  it('is not on a seat saved before the old seat halted', async () => {
    const [atOpen] = await haltFrames({
      ran: crewWith(seatId, CODEX),
      savedAtOpen: crewWith(seatId, CLAUDE),
      issue: usageHalt(seatId),
    });

    expect(atOpen).not.toContain('(resets');
  });

  it('leaves the seat when another tool is saved while the halt waits', async () => {
    const [atOpen, afterSave] = await haltFrames({
      ran: crewWith(seatId, CODEX),
      issue: usageHalt(seatId),
      whileOpen: [crewWith(seatId, CLAUDE)],
    });

    expect(noteOn(atOpen ?? '', seatId)).toBe(true);
    expect(afterSave).not.toContain('(resets');
  });

  it('returns when the halted seat is saved back', async () => {
    const [, away, back] = await haltFrames({
      ran: crewWith(seatId, CODEX),
      issue: usageHalt(seatId),
      whileOpen: [crewWith(seatId, CLAUDE), crewWith(seatId, CODEX)],
    });

    expect(away).not.toContain('(resets');
    expect(noteOn(back ?? '', seatId)).toBe(true);
  });

  it('leaves the seat when another model of the same tool is saved', async () => {
    const [, afterSave] = await haltFrames({
      ran: crewWith(seatId, CODEX),
      issue: usageHalt(seatId),
      whileOpen: [crewWith(seatId, CODEX_O3)],
    });

    expect(afterSave).not.toContain('(resets');
  });

  it('stays when only the effort of the halted seat is saved', async () => {
    const [, afterSave] = await haltFrames({
      ran: crewWith(seatId, CODEX),
      issue: usageHalt(seatId),
      whileOpen: [crewWith(seatId, CODEX_LOW)],
    });

    expect(noteOn(afterSave ?? '', seatId)).toBe(true);
  });

  it('is not on the seat saved at rest when a reopened run continues', async () => {
    const saved = crewWith(seatId, CLAUDE);
    const [atOpen] = await haltFrames({
      ran: crewWith(seatId, CODEX),
      savedAtOpen: saved,
      configOfRun: saved,
      issue: usageHalt(seatId),
    });

    expect(atOpen).not.toContain('(resets');
  });
});

describe('the reset note where a seat is not its own', () => {
  it('leaves REVIEW when the planner holds it and PLAN is saved', async () => {
    const ran = makeConfig({ planner: CODEX, implementer: CLAUDE });
    const [atOpen, afterSave] = await haltFrames({
      ran,
      issue: usageHalt('review'),
      whileOpen: [makeConfig({ planner: CLAUDE, implementer: CLAUDE })],
    });

    expect(atOpen).toContain('(resets');
    expect(afterSave).not.toContain('(resets');
  });

  it('is not on the default BUILD seat when a named profile halted', async () => {
    const ran = makeConfig({
      planner: CLAUDE,
      implementer: CLAUDE,
      reviewer: CLAUDE,
      implementerProfiles: { default: 'main', profiles: { main: CLAUDE, fast: CODEX } },
    });
    const [atOpen] = await haltFrames({
      ran,
      issue: usageHalt('build', { selectedImplementerProfile: 'fast' }),
    });

    expect(atOpen).not.toContain('(resets');
  });

  it('is on the default BUILD seat when the halted profile is the same seat', async () => {
    const ran = makeConfig({
      planner: CLAUDE,
      implementer: CODEX,
      reviewer: CLAUDE,
      implementerProfiles: { default: 'main', profiles: { main: CODEX, fast: CODEX } },
    });
    const [atOpen] = await haltFrames({
      ran,
      issue: usageHalt('build', { selectedImplementerProfile: 'fast' }),
    });

    expect(noteOn(atOpen ?? '', 'build')).toBe(true);
  });

  it('sits on an API seat that halted and leaves it when a CLI seat is saved', async () => {
    const [atOpen, afterSave] = await haltFrames({
      ran: crewWith('build', OLLAMA),
      issue: usageHalt('build', { facts: { tool: 'Ollama', cause: 'rate-limit' } }),
      whileOpen: [crewWith('build', CLAUDE)],
    });

    expect(noteOn(atOpen ?? '', 'build')).toBe(true);
    expect(afterSave).not.toContain('(resets');
  });

  it('shows no note for a halt without a reset or without a seat', async () => {
    const ran = crewWith('build', CODEX);
    const [noReset] = await haltFrames({ ran, issue: usageHalt('build', { resetAt: undefined }) });
    const [noSeat] = await haltFrames({ ran, issue: usageHalt('build', { seat: undefined }) });

    expect(noReset).not.toContain('(resets');
    expect(noSeat).not.toContain('(resets');
  });

  it('opens no note while the declared fallback is taken at once', async () => {
    const ran = crewWith('build', CODEX);
    const projectDir = createTempDir('reset-note-auto');
    dirs.push(projectDir);
    const ref = { projectDir, sessionId: 'sess-auto' };
    ensureSessionDir(projectDir, ref.sessionId);
    writeSeatIdentities(ref, seatIdentitiesFromConfig(ran));
    const issue = usageHalt('build', {
      availableActions: ['retry-same-worker', 'switch-seat', 'retry-later', 'end-run'],
      switchSeat: {
        seat: 'build',
        from: { tool: 'codex', model: 'gpt-5-codex' },
        candidates: [{ tool: 'claude-code', model: 'claude-3-5-sonnet' }],
        auto: {
          candidate: { tool: 'claude-code', model: 'claude-3-5-sonnet' },
          configRevision: 'revision',
        },
      },
    });
    saveState(ref, makeImplState([makeTask({ id: 'T001' })], { pendingRecovery: issue }));
    const state = loadState(ref);
    if (state === null) throw new Error('expected the halted state to persist');
    save(ran);
    const prepared = makePreparedExecution({
      ...ref,
      feature: 'reset note',
      config: ran,
      resumeState: state,
      active: reactivateExistingSession(ref),
    });
    const opens: unknown[] = [];
    const stop = recoveryNoticeStore.subscribe(() => opens.push(recoveryNoticeStore.get().issue));
    await createRecoveryDriver({
      prepared,
      configOfRun: prepared.sourceConfig,
      inputMode: {
        mode: 'question',
        hint: '',
        questionEpoch: 0,
        setReviewMode: async () => ({ approved: false }),
        setQuestionMode: async () => plainAnswer(''),
        resolve: () => {},
        resetMode: () => {},
      },
      abortedRef: { current: false },
      retentionNoticeHandled: { current: true },
      sink: addTuiEvent,
      setInlineResume: () => {},
    })({ state, controller: new AbortController(), republishPrompt: false });
    stop();

    expect(opens.filter((issue) => issue !== null)).toEqual([]);
    expect(await seatLine()).not.toContain('(resets');
  });

  it('is not on the seat the switch-seat picker saved while the halt is still open', async () => {
    const ran = crewWith('build', CODEX);
    const projectDir = createTempDir('reset-note-switch');
    dirs.push(projectDir);
    const ref = { projectDir, sessionId: 'sess-switch' };
    ensureSessionDir(projectDir, ref.sessionId);
    writeSeatIdentities(ref, seatIdentitiesFromConfig(ran));
    const issue = usageHalt('build', {
      availableActions: ['retry-same-worker', 'switch-seat', 'retry-later', 'end-run'],
      recommendedAction: 'switch-seat',
      switchSeat: {
        seat: 'build',
        from: { tool: 'codex', model: 'gpt-5-codex' },
        candidates: [{ tool: 'claude-code', model: 'claude-3-5-sonnet' }],
      },
    });
    saveState(ref, makeImplState([makeTask({ id: 'T001' })], { pendingRecovery: issue }));
    const state = loadState(ref);
    if (state === null) throw new Error('expected the halted state to persist');
    save(ran);
    const prepared = makePreparedExecution({
      ...ref,
      feature: 'reset note',
      config: ran,
      resumeState: state,
      active: reactivateExistingSession(ref),
    });
    const pending = createRecoveryDriver({
      prepared,
      configOfRun: prepared.sourceConfig,
      inputMode: {
        mode: 'question',
        hint: '',
        questionEpoch: 0,
        setReviewMode: async () => ({ approved: false }),
        setQuestionMode: async () => plainAnswer('switch-seat'),
        resolve: () => {},
        resetMode: () => {},
      },
      abortedRef: { current: false },
      retentionNoticeHandled: { current: true },
      sink: addTuiEvent,
      setInlineResume: () => {},
    })({ state, controller: new AbortController(), republishPrompt: false });
    await vi.waitFor(() => {
      expect(overlayStore.get().active).toBe('implementer-picker');
    });
    const beforeSave = await seatLine();
    save(crewWith('build', CLAUDE));
    const inWindow = await seatLine();
    pickerViewStore.setCommitted(true);
    overlayStore.close();
    await pending;

    expect(noteOn(beforeSave, 'build')).toBe(true);
    expect(recoveryNoticeStore.get().issue).toBeNull();
    expect(inWindow).not.toContain('(resets');
  });
});
