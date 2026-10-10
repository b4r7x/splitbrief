import { afterEach, describe, expect, it, vi } from 'vitest';
import { unlinkSync } from 'node:fs';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { loadConfig, writeConfig } from '../../../core/config/load/io.js';
import { configPath, readConfigDocument } from '../../../core/config/load/document.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import type { Config } from '../../../core/schemas/config.js';
import type { SwitchSeatOffer } from '../../../core/schemas/recovery/schemas.js';
import type { PreparationPolicy } from '../../runners/prepare-execution/types.js';
import type { PreparationOutcome, PreparedExecution } from '../../runners/prepared-execution.js';
import type { prepareExecution } from '../../runners/prepare-execution/prepare-execution.js';
import { switchSeatAndPrepareResume } from './switch-seat-resume.js';
import { seatRunnerValue } from './actions.js';

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

type SeatWriter = NonNullable<Parameters<typeof switchSeatAndPrepareResume>[0]['writeSeat']>;

function preparedFor(config: Config): PreparationOutcome {
  return {
    kind: 'prepared',
    execution: { config, purpose: 'resume' } as unknown as PreparedExecution,
  };
}

function setup(
  name: string,
  offered: boolean,
  options?: Readonly<{
    selectedImplementerProfile?: string;
    config?: Config;
    switchSeat?: SwitchSeatOffer;
  }>,
) {
  const projectDir = createTempDir(name);
  dirs.push(projectDir);
  const sessionId = `sess-${name}`;
  ensureSessionDir(projectDir, sessionId);
  const task = makeTask({ id: 'T001' });
  const defaultSwitchSeat: SwitchSeatOffer | undefined = offered
    ? { seat: 'build', candidates: [{ tool: 'claude-code', model: 'sonnet' }] }
    : undefined;
  const switchSeat = options?.switchSeat ?? defaultSwitchSeat;
  const state = makeImplState([task], {
    pendingRecovery: makeRecoveryIssue({
      reason: 'runner-usage-limit',
      taskId: task.id,
      affectedTaskIds: [task.id],
      availableActions: offered
        ? ['retry-same-worker', 'switch-seat', 'skip-current-task', 'end-run']
        : ['retry-same-worker', 'skip-current-task', 'end-run'],
      recommendedAction: offered ? 'switch-seat' : 'retry-same-worker',
      ...(switchSeat !== undefined && { switchSeat }),
      selectedImplementerProfile: options?.selectedImplementerProfile,
    }),
  });
  saveState({ projectDir, sessionId }, state);
  const config = options?.config ?? makeConfig({ implementer: { kind: 'cli', tool: 'codex' } });
  writeConfig(projectDir, config);
  return { projectDir, sessionId, state, config };
}

function profileTableConfig() {
  return makeConfig({
    implementer: { kind: 'cli', tool: 'opencode' },
    implementerProfiles: {
      default: 'small',
      profiles: {
        small: { kind: 'cli', tool: 'opencode' },
        big: { kind: 'cli', tool: 'codex' },
      },
    },
  });
}

function prepareReturning(outcome: PreparationOutcome) {
  return vi.fn(async () => outcome) as unknown as typeof prepareExecution;
}

describe('switchSeatAndPrepareResume', () => {
  it.each(['plan', 'build', 'review'] as const)(
    'keeps a fallback saved after preparation during a manual %s switch',
    async (seat) => {
      const runner = { kind: 'cli', tool: 'codex' } as const;
      const config = makeConfig({ planner: runner, implementer: runner });
      const candidate = { tool: 'claude-code', model: 'sonnet' };
      const { projectDir, sessionId, state } = setup(`manual-fallback-${seat}`, true, {
        config,
        switchSeat: { seat, candidates: [candidate] },
      });
      const fallback = { tool: 'opencode', model: 'provider/model', variant: 'high' };
      writeConfig(
        projectDir,
        makeConfig({
          planner: { ...runner, fallback },
          implementer: { ...runner, fallback },
        }),
      );
      const revision = readConfigDocument(projectDir).revision?.rawSha256;
      const { bus } = makeBusRecorder();
      const result = await switchSeatAndPrepareResume({
        projectDir,
        sessionId,
        state,
        config,
        candidate,
        bus,
        policy: RESUME_POLICY,
        signal: new AbortController().signal,
        prepare: async (input) => {
          expect(
            seatRunnerValue(input.effectiveConfig ?? config, seat, undefined).fallback,
          ).toEqual(fallback);
          return preparedFor(input.effectiveConfig ?? config);
        },
      });
      expect(result.kind).toBe('switched');
      if (result.kind !== 'switched') throw new Error('expected a manual switch');
      expect(seatRunnerValue(result.config, seat, undefined).fallback).toEqual(fallback);
      expect(seatRunnerValue(loadConfig(projectDir).config, seat, undefined).fallback).toEqual(
        fallback,
      );
      expect(result.state.seatSwitches?.[0]).toMatchObject({
        auto: false,
        configRevision: revision,
      });
      expect(revision).toBeDefined();
      if (seat === 'review') {
        expect(result.config.planner).toEqual(config.planner);
        expect(loadConfig(projectDir).config.planner.fallback).toEqual(fallback);
        expect(result.config.reviewer).toBeDefined();
      }
    },
  );

  it.each(['small', 'big'])('keeps the fallback of record of BUILD profile %s', async (profile) => {
    const config = profileTableConfig();
    const { projectDir, sessionId, state } = setup(`manual-profile-fallback-${profile}`, true, {
      config,
      selectedImplementerProfile: profile,
    });
    const fallback = { tool: 'opencode', model: 'profile/model', variant: 'high' };
    const profiles = config.implementerProfiles;
    const existing = profiles?.profiles[profile];
    if (profiles === undefined || existing === undefined) throw new Error('expected profiles');
    writeConfig(projectDir, {
      ...config,
      implementerProfiles: {
        ...profiles,
        profiles: { ...profiles.profiles, [profile]: { ...existing, fallback } },
      },
    });
    const { bus } = makeBusRecorder();
    const result = await switchSeatAndPrepareResume({
      projectDir,
      sessionId,
      state,
      config,
      candidate: { tool: 'claude-code' },
      bus,
      policy: RESUME_POLICY,
      signal: new AbortController().signal,
      prepare: async (input) => preparedFor(input.effectiveConfig ?? config),
    });
    expect(result.kind).toBe('switched');
    if (result.kind !== 'switched') throw new Error('expected a manual switch');
    expect(result.config.implementerProfiles?.profiles[profile]?.fallback).toEqual(fallback);
    expect(loadConfig(projectDir).config.implementerProfiles?.profiles[profile]?.fallback).toEqual(
      fallback,
    );
  });

  it('keeps an explicit REVIEW with no fallback after a PLAN fallback is saved', async () => {
    const runner = { kind: 'cli', tool: 'codex' } as const;
    const config = makeConfig({ planner: runner, reviewer: runner });
    const { projectDir, sessionId, state } = setup('manual-explicit-review-fallback', true, {
      config,
      switchSeat: { seat: 'review', candidates: [{ tool: 'claude-code' }] },
    });
    writeConfig(projectDir, { ...config, planner: { ...runner, fallback: { tool: 'opencode' } } });
    const { bus } = makeBusRecorder();
    const result = await switchSeatAndPrepareResume({
      projectDir,
      sessionId,
      state,
      config,
      candidate: { tool: 'claude-code' },
      bus,
      policy: RESUME_POLICY,
      signal: new AbortController().signal,
      prepare: async (input) => preparedFor(input.effectiveConfig ?? config),
    });
    expect(result.kind).toBe('switched');
    if (result.kind !== 'switched') throw new Error('expected a manual switch');
    expect(result.config.reviewer?.fallback).toBeUndefined();
    expect(loadConfig(projectDir).config.reviewer?.fallback).toBeUndefined();
  });

  it('honours a fallback cleared after preparation on a manual switch', async () => {
    const config = makeConfig({
      implementer: {
        kind: 'cli',
        tool: 'codex',
        fallback: { tool: 'opencode' },
      },
    });
    const { projectDir, sessionId, state } = setup('manual-cleared-fallback', true, { config });
    writeConfig(projectDir, makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }));
    const { bus } = makeBusRecorder();
    const result = await switchSeatAndPrepareResume({
      projectDir,
      sessionId,
      state,
      config,
      candidate: { tool: 'claude-code' },
      bus,
      policy: RESUME_POLICY,
      signal: new AbortController().signal,
      prepare: async (input) => preparedFor(input.effectiveConfig ?? config),
    });
    expect(result.kind).toBe('switched');
    if (result.kind !== 'switched') throw new Error('expected a manual switch');
    expect(result.config.implementer.fallback).toBeUndefined();
    expect(loadConfig(projectDir).config.implementer.fallback).toBeUndefined();
  });

  it('uses the prepared fallback when there is no config of record', async () => {
    const fallback = { tool: 'opencode' };
    const config = makeConfig({ implementer: { kind: 'cli', tool: 'codex', fallback } });
    const { projectDir, sessionId, state } = setup('manual-no-record-fallback', true, { config });
    unlinkSync(configPath(projectDir));
    const { bus } = makeBusRecorder();
    const result = await switchSeatAndPrepareResume({
      projectDir,
      sessionId,
      state,
      config,
      candidate: { tool: 'claude-code' },
      bus,
      policy: RESUME_POLICY,
      signal: new AbortController().signal,
      prepare: async (input) => preparedFor(input.effectiveConfig ?? config),
    });
    expect(result.kind).toBe('switched');
    if (result.kind !== 'switched') throw new Error('expected a manual switch');
    expect(result.config.implementer.fallback).toEqual(fallback);
    expect(readConfigDocument(projectDir).revision).toBeNull();
  });

  it('keeps a fallback save during preparation by refusing the stale switch write', async () => {
    const { projectDir, sessionId, state, config } = setup('manual-fallback-conflict', true);
    const fallback = { tool: 'opencode', model: 'new/model' };
    const { bus } = makeBusRecorder();
    const result = await switchSeatAndPrepareResume({
      projectDir,
      sessionId,
      state,
      config,
      candidate: { tool: 'claude-code' },
      bus,
      policy: RESUME_POLICY,
      signal: new AbortController().signal,
      prepare: async (input) => {
        writeConfig(projectDir, { ...config, implementer: { ...config.implementer, fallback } });
        return preparedFor(input.effectiveConfig ?? config);
      },
    });
    expect(result).toMatchObject({ kind: 'unswitched', outcome: 'conflict' });
    expect(loadConfig(projectDir).config.implementer.fallback).toEqual(fallback);
    expect(result.state.pendingRecovery).toBeDefined();
  });

  it('persists an automatic swap with the old seat as fallback before resolving the halt', async () => {
    const candidate = { tool: 'opencode', model: 'provider/model', variant: 'high' };
    const config = makeConfig({
      implementer: {
        kind: 'cli',
        tool: 'codex',
        model: 'gpt-5-codex',
        effort: 'high',
        fallback: candidate,
      },
    });
    const setupResult = setup('seat-swap-places', true, {
      config,
      switchSeat: { seat: 'build', candidates: [candidate] },
    });
    const { projectDir, sessionId, state } = setupResult;
    const configRevision = readConfigDocument(projectDir).revision?.rawSha256;
    if (configRevision === undefined || state.pendingRecovery?.switchSeat === undefined)
      throw new Error('expected a saved halt');
    state.pendingRecovery.switchSeat.auto = { candidate, configRevision };
    saveState({ projectDir, sessionId }, state);
    const { bus } = makeBusRecorder();
    const result = await switchSeatAndPrepareResume({
      projectDir,
      sessionId,
      state,
      config,
      candidate,
      bus,
      policy: RESUME_POLICY,
      signal: new AbortController().signal,
      prepare: async (input) => preparedFor(input.effectiveConfig ?? config),
    });
    expect(result.kind).toBe('switched');
    if (result.kind !== 'switched') throw new Error('expected a switch');
    const expected = {
      kind: 'cli',
      ...candidate,
      fallback: { tool: 'codex', model: 'gpt-5-codex', effort: 'high' },
    };
    expect(result.config.implementer).toEqual(expected);
    expect(loadConfig(projectDir).config.implementer).toEqual(expected);
    expect(result.state.seatSwitches?.[0]?.auto).toBe(true);
  });
  it('prepares on the switched config, writes that one seat, then resolves the halt', async () => {
    const { projectDir, sessionId, state, config } = setup('seat-swap-resume', true);
    const { bus } = makeBusRecorder();
    const switched = makeConfig({ implementer: { kind: 'cli', tool: 'claude-code' } });
    const prepare = prepareReturning(preparedFor(switched));

    const result = await switchSeatAndPrepareResume({
      projectDir,
      sessionId,
      state,
      bus,
      config,
      candidate: { tool: 'claude-code', model: 'sonnet' },
      policy: RESUME_POLICY,
      signal: new AbortController().signal,
      prepare,
    });

    expect(result.kind).toBe('switched');
    if (result.kind !== 'switched') return;
    expect(result.seat).toBe('build');
    expect(result.config.implementer).toMatchObject({
      kind: 'cli',
      tool: 'claude-code',
      model: 'sonnet',
    });
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(vi.mocked(prepare).mock.calls[0]?.[0]).toMatchObject({
      existingSession: { projectDir, sessionId },
      effectiveConfig: { implementer: { tool: 'claude-code' } },
      policy: { purpose: 'resume' },
    });
    // The one-seat writer landed the chosen tool in the config of record.
    expect(loadConfig(projectDir).config.implementer).toMatchObject({
      kind: 'cli',
      tool: 'claude-code',
      model: 'sonnet',
    });
  });

  it('blocks — and never prepares — when the issue offered no seat', async () => {
    const { projectDir, sessionId, state, config } = setup('seat-swap-resume-unoffered', false);
    const { bus } = makeBusRecorder();
    const prepare = prepareReturning({ kind: 'aborted' });

    const result = await switchSeatAndPrepareResume({
      projectDir,
      sessionId,
      state,
      bus,
      config,
      candidate: { tool: 'claude-code' },
      policy: RESUME_POLICY,
      signal: new AbortController().signal,
      prepare,
    });

    expect(result).toMatchObject({ kind: 'blocked', code: 'seat-swap-unavailable' });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('prepares the resume on the profile that failed, leaving the default alone', async () => {
    const options = { selectedImplementerProfile: 'big', config: profileTableConfig() };
    const { projectDir, sessionId, state, config } = setup(
      'seat-swap-resume-profile',
      true,
      options,
    );
    const { bus } = makeBusRecorder();
    const prepare = prepareReturning({
      kind: 'failed',
      error: new Error('not admitted'),
    });

    const result = await switchSeatAndPrepareResume({
      projectDir,
      sessionId,
      state,
      bus,
      config,
      candidate: { tool: 'claude-code', model: 'sonnet' },
      policy: RESUME_POLICY,
      signal: new AbortController().signal,
      prepare,
    });

    // A preparation that was not admitted writes nothing, so the halt stays.
    expect(result).toMatchObject({ kind: 'unswitched', outcome: 'unadmitted' });
    expect(vi.mocked(prepare).mock.calls[0]?.[0]).toMatchObject({
      effectiveConfig: {
        implementer: { tool: 'opencode' },
        implementerProfiles: {
          profiles: {
            small: { tool: 'opencode' },
            big: { tool: 'claude-code', model: 'sonnet' },
          },
        },
      },
    });
    expect(config).toEqual(profileTableConfig());
    expect(loadState({ projectDir, sessionId })?.pendingRecovery).toBeDefined();
  });

  it('blocks — and changes neither config nor state — when the failing profile is gone', async () => {
    const { projectDir, sessionId, state, config } = setup(
      'seat-swap-resume-missing-profile',
      true,
      { selectedImplementerProfile: 'huge', config: profileTableConfig() },
    );
    const { bus } = makeBusRecorder();
    const prepare = prepareReturning({ kind: 'aborted' });

    const result = await switchSeatAndPrepareResume({
      projectDir,
      sessionId,
      state,
      bus,
      config,
      candidate: { tool: 'claude-code', model: 'sonnet' },
      policy: RESUME_POLICY,
      signal: new AbortController().signal,
      prepare,
    });

    expect(result).toMatchObject({ kind: 'blocked', code: 'profile-not-found', state });
    expect(prepare).not.toHaveBeenCalled();
    expect(config).toEqual(profileTableConfig());
    expect(loadState({ projectDir, sessionId })).toEqual(state);
  });

  it('writes nothing and keeps the halt when the operator stopped before the write', async () => {
    const { projectDir, sessionId, state, config } = setup('seat-swap-resume-abort', true);
    const { bus } = makeBusRecorder();
    const controller = new AbortController();
    controller.abort();
    const switched = makeConfig({ implementer: { kind: 'cli', tool: 'claude-code' } });
    const before = loadConfig(projectDir).rawYaml;

    const result = await switchSeatAndPrepareResume({
      projectDir,
      sessionId,
      state,
      bus,
      config,
      candidate: { tool: 'claude-code', model: 'sonnet' },
      policy: RESUME_POLICY,
      signal: controller.signal,
      prepare: prepareReturning(preparedFor(switched)),
    });

    expect(result).toMatchObject({ kind: 'unswitched', outcome: 'aborted' });
    expect(result.state.pendingRecovery).toBeDefined();
    expect(loadConfig(projectDir).rawYaml).toBe(before);
  });

  it('writes nothing and keeps the halt when the seat write conflicts', async () => {
    const { projectDir, sessionId, state, config } = setup('seat-swap-resume-conflict', true);
    const { bus } = makeBusRecorder();
    const switched = makeConfig({ implementer: { kind: 'cli', tool: 'claude-code' } });
    const before = loadConfig(projectDir).rawYaml;
    const writeSeat = vi.fn(async () => 'conflict' as const) as unknown as SeatWriter;

    const result = await switchSeatAndPrepareResume({
      projectDir,
      sessionId,
      state,
      bus,
      config,
      candidate: { tool: 'claude-code', model: 'sonnet' },
      policy: RESUME_POLICY,
      signal: new AbortController().signal,
      prepare: prepareReturning(preparedFor(switched)),
      writeSeat,
    });

    expect(result).toMatchObject({ kind: 'unswitched', outcome: 'conflict' });
    expect(result.state.pendingRecovery).toBeDefined();
    expect(loadConfig(projectDir).rawYaml).toBe(before);
  });

  it('finishes a crashed write with no second write when the seat of record is the candidate', async () => {
    const switched = makeConfig({
      implementer: { kind: 'cli', tool: 'claude-code', model: 'sonnet' },
    });
    const { projectDir, sessionId, state } = setup('seat-swap-resume-crash-same', true, {
      config: switched,
      switchSeat: {
        seat: 'build',
        candidates: [{ tool: 'claude-code', model: 'sonnet' }],
        auto: {
          candidate: { tool: 'claude-code', model: 'sonnet' },
          configRevision: 'stale-revision',
        },
      },
    });
    const { bus } = makeBusRecorder();
    const staleConfig = makeConfig({ implementer: { kind: 'cli', tool: 'codex' } });
    const writeSeat = vi.fn(async () => 'saved' as const) as unknown as SeatWriter;

    const result = await switchSeatAndPrepareResume({
      projectDir,
      sessionId,
      state,
      bus,
      config: staleConfig,
      candidate: { tool: 'claude-code', model: 'sonnet' },
      policy: RESUME_POLICY,
      signal: new AbortController().signal,
      prepare: prepareReturning(preparedFor(switched)),
      writeSeat,
    });

    expect(result.kind).toBe('switched');
    expect(writeSeat).not.toHaveBeenCalled();
    if (result.kind !== 'switched') return;
    expect(result.state.seatSwitches?.[0]?.auto).toBe(true);
    expect(result.state.pendingRecovery).toBeUndefined();
  });

  it('keeps the recorded swap when a crashed resume was prepared on the already-switched seat', async () => {
    const candidate = { tool: 'claude-code', model: 'sonnet' } as const;
    const config = makeConfig({
      implementer: {
        kind: 'cli',
        ...candidate,
        fallback: { tool: 'codex', model: 'gpt-5-codex', effort: 'high' },
      },
    });
    const { projectDir, sessionId, state } = setup('seat-swap-replay-record', true, {
      config,
      switchSeat: {
        seat: 'build',
        candidates: [candidate],
        auto: { candidate, configRevision: 'stale-revision' },
      },
    });
    const before = loadConfig(projectDir).rawYaml;
    const { bus } = makeBusRecorder();
    const result = await switchSeatAndPrepareResume({
      projectDir,
      sessionId,
      state,
      config,
      candidate,
      bus,
      policy: RESUME_POLICY,
      signal: new AbortController().signal,
      prepare: async (input) => preparedFor(input.effectiveConfig ?? config),
    });
    expect(result.kind).toBe('switched');
    if (result.kind !== 'switched') throw new Error('expected a switch');
    expect(result.config.implementer).toEqual(config.implementer);
    expect(loadConfig(projectDir).rawYaml).toBe(before);
    expect(result.state.seatSwitches?.[0]?.auto).toBe(true);
  });

  it('writes the halted seat when only another seat moved since the halt', async () => {
    const base = makeConfig({ implementer: { kind: 'cli', tool: 'codex' } });
    const onDisk: Config = { ...base, planner: { ...base.planner, model: 'another-model' } };
    const { projectDir, sessionId, state } = setup('seat-swap-resume-other-seat', true, {
      config: onDisk,
      switchSeat: {
        seat: 'build',
        candidates: [{ tool: 'claude-code', model: 'sonnet' }],
        auto: {
          candidate: { tool: 'claude-code', model: 'sonnet' },
          configRevision: 'stale-revision',
        },
      },
    });
    const { bus } = makeBusRecorder();

    const result = await switchSeatAndPrepareResume({
      projectDir,
      sessionId,
      state,
      bus,
      config: base,
      candidate: { tool: 'claude-code', model: 'sonnet' },
      policy: RESUME_POLICY,
      signal: new AbortController().signal,
      prepare: prepareReturning(preparedFor(base)),
    });

    expect(result.kind).toBe('switched');
    if (result.kind !== 'switched') return;
    expect(result.candidate.tool).toBe('claude-code');
    expect(result.state.seatSwitches?.[0]?.auto).toBe(true);
    const ofRecord = loadConfig(projectDir).config;
    expect(ofRecord.implementer).toMatchObject({
      kind: 'cli',
      tool: 'claude-code',
      model: 'sonnet',
    });
    expect(ofRecord.planner).toMatchObject({ model: 'another-model' });
  });

  it('drops the intent and resolves onto a different seat of record', async () => {
    const record = makeConfig({ implementer: { kind: 'cli', tool: 'opencode' } });
    const { projectDir, sessionId, state } = setup('seat-swap-resume-crash-other', true, {
      config: record,
      switchSeat: {
        seat: 'build',
        candidates: [{ tool: 'claude-code', model: 'sonnet' }],
        auto: {
          candidate: { tool: 'claude-code', model: 'sonnet' },
          configRevision: 'stale-revision',
        },
      },
    });
    const { bus } = makeBusRecorder();
    const staleConfig = makeConfig({ implementer: { kind: 'cli', tool: 'codex' } });
    const prepare = prepareReturning(preparedFor(record));

    const result = await switchSeatAndPrepareResume({
      projectDir,
      sessionId,
      state,
      bus,
      config: staleConfig,
      candidate: { tool: 'claude-code', model: 'sonnet' },
      policy: RESUME_POLICY,
      signal: new AbortController().signal,
      prepare,
    });

    expect(result.kind).toBe('switched');
    if (result.kind !== 'switched') return;
    expect(result.candidate.tool).toBe('opencode');
    expect(result.state.seatSwitches?.[0]?.auto).toBe(false);
    expect(vi.mocked(prepare).mock.calls[0]?.[0]).toMatchObject({
      effectiveConfig: { implementer: { tool: 'opencode' } },
    });
  });
});
