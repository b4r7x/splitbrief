import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cliDetectionFor, rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { readActiveRunner } from '../../../core/config/accessors/active-runner.js';
import { configPath } from '../../../core/config/load/document.js';
import { loadConfig, writeConfig } from '../../../core/config/load/io.js';
import type { CrewSeatId } from '../../../core/crew/identity.js';
import { CREW_SEAT_ROLES } from '../../../core/crew/seats.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { buildSeatDownIssue } from './builders/task.js';
import { loadSeatSwapContext } from './seat-swap-context.js';
import { switchSeatAndPrepareResume } from './switch-seat-resume.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

async function project(): Promise<string> {
  const dir = createTempDir('fallback-of-record');
  dirs.push(dir);
  await rememberDetectedTools(dir, [
    cliDetectionFor('ready', 'codex'),
    cliDetectionFor('ready', 'opencode'),
  ]);
  return dir;
}

describe('fallback of record', () => {
  it.each(['plan', 'build', 'review'] as const)(
    'offers and applies a fallback saved after preparation on %s',
    async (seat: CrewSeatId) => {
      const projectDir = await project();
      const runner = { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' } as const;
      const config = makeConfig({ planner: runner, implementer: runner });
      writeConfig(projectDir, config);
      const fallback = { tool: 'opencode', model: 'provider/model', variant: 'high' };
      writeConfig(
        projectDir,
        makeConfig({ planner: { ...runner, fallback }, implementer: { ...runner, fallback } }),
      );
      const context = await loadSeatSwapContext({ projectDir, seat, runner, config });
      const issue = buildSeatDownIssue({
        seat,
        runner,
        phase: seat === 'review' ? 'final-review' : seat === 'plan' ? 'planning' : 'implementing',
        classification: { class: 'account', cause: 'balance' },
        words: 'Insufficient Balance',
        seatSwap: context,
        createdAt: '2026-10-10T12:00:00.000Z',
      });
      expect(context?.fallback).toEqual(fallback);
      expect(issue.switchSeat?.candidates[0]).toEqual(fallback);
      expect(issue.switchSeat?.auto).toEqual({
        candidate: fallback,
        configRevision: loadConfig(projectDir).revision?.rawSha256,
      });
      const sessionId = `fallback-${seat}`;
      ensureSessionDir(projectDir, sessionId);
      const state = makeWorkflowState({ phase: issue.phase, pendingRecovery: issue });
      saveState({ projectDir, sessionId }, state);
      const { bus, events } = makeBusRecorder();
      const result = await switchSeatAndPrepareResume({
        projectDir,
        sessionId,
        state,
        config,
        candidate: fallback,
        bus,
        policy: {
          purpose: 'resume',
          interaction: 'headless',
          allowRepoRunners: false,
          allowHooks: false,
          unverifiedAuth: 'denied',
        },
        signal: new AbortController().signal,
        prepare: async (input) => ({
          kind: 'prepared',
          execution: makePreparedExecution({
            projectDir,
            sessionId,
            feature: state.feature,
            config: input.effectiveConfig ?? config,
            resumeState: state,
          }),
        }),
      });
      expect(result.kind).toBe('switched');
      if (result.kind !== 'switched') throw new Error('expected an automatic fallback switch');
      const switchedRunner = {
        kind: 'cli',
        ...fallback,
        fallback: { tool: runner.tool, model: runner.model },
      };
      const role = CREW_SEAT_ROLES[seat];
      const recorded = loadConfig(projectDir).config;
      expect(readActiveRunner({ config: result.config, role })).toEqual(switchedRunner);
      expect(readActiveRunner({ config: recorded, role })).toEqual(switchedRunner);
      expect(result.state.pendingRecovery).toBeUndefined();
      expect(result.state.seatSwitches).toEqual([
        expect.objectContaining({
          seat,
          auto: true,
          configRevision: issue.switchSeat?.auto?.configRevision,
        }),
      ]);
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'seat_switched', seat, auto: true }),
      );
      if (seat === 'review') {
        expect(recorded.reviewer).toEqual(switchedRunner);
        expect(recorded.planner).toEqual({ ...runner, fallback });
      }
    },
  );

  it('reads the failing named profile fallback instead of the default or prepared one', async () => {
    const projectDir = await project();
    const runner = { kind: 'cli', tool: 'codex' } as const;
    const config = makeConfig({ implementer: runner });
    const fallback = { tool: 'opencode', model: 'profile/model' };
    writeConfig(
      projectDir,
      makeConfig({
        implementer: { ...runner, fallback: { tool: 'claude-code' } },
        implementerProfiles: {
          default: 'fast',
          profiles: {
            fast: { ...runner, fallback: { tool: 'claude-code' } },
            big: { ...runner, fallback },
          },
        },
      }),
    );
    const context = await loadSeatSwapContext({
      projectDir,
      seat: 'build',
      runner,
      config,
      implementerProfile: 'big',
    });
    expect(context?.fallback).toEqual(fallback);
  });

  it.each([
    'version: 3\nplanner:\n  kind: cli\n  tool: invalid-tool\n',
    'version: 3\nimplementer: [broken\n',
  ])('keeps a manual switch pending when config of record is invalid: %s', async (rawYaml) => {
    const projectDir = await project();
    const runner = {
      kind: 'cli',
      tool: 'codex',
      fallback: { tool: 'opencode', model: 'prepared/model' },
    } as const;
    const config = makeConfig({ implementer: runner });
    writeConfig(projectDir, config);
    writeFileSync(configPath(projectDir), rawYaml);
    const context = await loadSeatSwapContext({ projectDir, seat: 'build', runner, config });
    const issue = buildSeatDownIssue({
      seat: 'build',
      runner,
      classification: { class: 'account', cause: 'balance' },
      words: 'Insufficient Balance',
      phase: 'implementing',
      seatSwap: context,
      createdAt: '2026-10-10T12:00:00.000Z',
    });
    expect(context?.fallback).toBeUndefined();
    expect(issue.switchSeat?.auto).toBeUndefined();
    expect(issue.switchSeat?.candidates).not.toContainEqual(runner.fallback);
    expect(issue.details[1]).toBe('fallback: not read · config.yaml does not load');
    expect(issue.facts?.fallback).toBeUndefined();
    const sessionId = 'invalid-config-manual-switch';
    const ref = { projectDir, sessionId };
    ensureSessionDir(projectDir, sessionId);
    const state = makeWorkflowState({ phase: issue.phase, pendingRecovery: issue });
    saveState(ref, state);
    const result = await switchSeatAndPrepareResume({
      ...ref,
      state,
      config,
      candidate: { tool: 'opencode' },
      bus: makeBusRecorder().bus,
      policy: {
        purpose: 'resume',
        interaction: 'headless',
        allowRepoRunners: false,
        allowHooks: false,
        unverifiedAuth: 'denied',
      },
      signal: new AbortController().signal,
      prepare: async () => {
        throw new Error('A blocked switch must not prepare a runner');
      },
    });
    expect(result).toMatchObject({
      kind: 'blocked',
      code: 'fallback-read-failed',
      message: expect.stringContaining('config.yaml does not load'),
    });
    expect(result.state.pendingRecovery).toEqual(issue);
    expect(loadState(ref)?.pendingRecovery).toEqual(issue);
    expect(readFileSync(configPath(projectDir), 'utf8')).toBe(rawYaml);
  });

  it('keeps an explicit REVIEW with no fallback independent of PLAN', async () => {
    const projectDir = await project();
    const runner = { kind: 'cli', tool: 'codex' } as const;
    const config = makeConfig({
      planner: { ...runner, fallback: { tool: 'opencode' } },
      reviewer: runner,
    });
    writeConfig(projectDir, config);
    const context = await loadSeatSwapContext({ projectDir, seat: 'review', runner, config });
    expect(context?.fallback).toBeUndefined();
  });
});
