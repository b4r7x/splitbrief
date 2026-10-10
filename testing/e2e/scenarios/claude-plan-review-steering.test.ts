import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { isQueuedMessagePendingFirstDelivery } from '../../../src/core/queue-state.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { detectAvailableCliTools } from '../../../src/engine/detection/detect.js';
import { reapOrphanRunners } from '../../../src/engine/orchestrator/run/orphan-reaper.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import {
  claudePlannerSteerPaths,
  installClaudePlannerSteerShim,
  readClaudePlannerSteers,
} from '../helpers/claude-planner-steer-shim.js';
import { buildSteeringCli, readSteeringLog, STEERING_WAIT } from '../helpers/steer-e2e-workflow.js';
import {
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
} from '../helpers/stop-continue-fixture.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

beforeAll(buildSteeringCli, 120_000);

it('delivers PLAN and REVIEW messages to the running Claude calls before their verdicts finish', async () => {
  const target = createStopContinueFixture(
    () => `
import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
`,
    { isolation: 'none' },
  );
  const home = useTrustHome('claude-planner-steer-home');
  let restorePath: (() => void) | undefined;
  try {
    mkdirSync(join(home.home, '.claude'), { recursive: true });
    writeFileSync(join(home.home, '.claude', '.credentials.json'), '{"fixture":true}\n');
    const bin = join(target.tmpDir, 'bin');
    mkdirSync(bin);
    installClaudePlannerSteerShim(target.tmpDir, bin);
    restorePath = activateSafeCliShimPath(bin);
    const config = loadConfig(target.projectDir).config;
    const claude = { kind: 'cli', tool: 'claude-code', model: 'sonnet' } as const;
    writeConfig(target.projectDir, {
      ...config,
      planner: claude,
      reviewer: claude,
      workflow: { ...config.workflow, git: { createBranch: false } },
    });
    await trustDeclaredRunners({
      projectDir: target.projectDir,
      config: loadConfig(target.projectDir).config,
    });
    const tools = await detectAvailableCliTools({
      projectDir: target.projectDir,
      tools: ['claude-code'],
      authChannels: { 'claude-code': 'session' },
      role: 'planner',
    });
    expect(tools[0]?.diagnostic.state, JSON.stringify(tools[0]?.diagnostic)).toBe('ready');
    await rememberDetectedTools(target.projectDir, tools);
    const offline = join(target.tmpDir, 'offline.mjs');
    writeFileSync(
      offline,
      "globalThis.fetch = async () => { throw new Error('Network disabled in Claude planner E2E'); };\n",
    );
    await runWithPtyChild(
      {
        requirement: 'required',
        argv: [
          '--import',
          offline,
          'dist/cli.js',
          'start',
          'smoke',
          '--allow-repo-runners',
          '--project',
          target.projectDir,
        ],
        spawnOptions: {
          name: 'xterm-256color',
          cols: 100,
          rows: 30,
          cwd: REPO_ROOT,
          env: { ...safeChildEnvironment(home.home), XDG_STATE_HOME: target.stateHome },
        },
      },
      async (child) => {
        const exit = Promise.withResolvers<PtyExitEvent>();
        let outcome: PtyExitEvent | undefined;
        let terminal = '';
        const exitListener = child.onExit((event) => {
          outcome = event;
          exit.resolve(event);
        });
        const dataListener = child.onData((data) => {
          terminal += data;
        });
        try {
          await expect
            .poll(
              () => existsSync(claudePlannerSteerPaths(target.tmpDir, 'plan').started),
              STEERING_WAIT,
            )
            .toBe(true);
          const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
          if (sessionId === undefined) throw new Error('PLAN started without a run session');
          for (const seat of ['plan', 'review'] as const) {
            const paths = claudePlannerSteerPaths(target.tmpDir, seat);
            const message = `MID_CALL_CLAUDE_${seat.toUpperCase()}`;
            await expect.poll(() => existsSync(paths.started), STEERING_WAIT).toBe(true);
            await expect
              .poll(() => terminal, STEERING_WAIT)
              .toContain(`Message ${seat.toUpperCase()}`);
            await expect
              .poll(
                () =>
                  readSteeringLog(target.projectDir, sessionId).some(
                    (entry) =>
                      entry.kind === 'event' &&
                      entry.type === 'steerable_call' &&
                      entry.data.seat === seat,
                  ),
                STEERING_WAIT,
              )
              .toBe(true);
            child.write(message);
            await expect.poll(() => terminal, STEERING_WAIT).toContain(message);
            child.write('\r');
            await expect
              .poll(
                () =>
                  readClaudePlannerSteers(target.tmpDir).filter(
                    (entry) => entry.kind === 'steer' && entry.seat === seat,
                  ),
                STEERING_WAIT,
              )
              .toHaveLength(1);
            const captures = readClaudePlannerSteers(target.tmpDir);
            const call = captures.find((entry) => entry.kind === 'call' && entry.seat === seat);
            expect(
              captures.find((entry) => entry.kind === 'steer' && entry.seat === seat),
            ).toMatchObject({
              text: expect.stringContaining(message),
              pid: call?.pid,
              beforeFinish: true,
            });
            expect(call?.args).toEqual(
              expect.arrayContaining([
                '--input-format',
                'stream-json',
                '--replay-user-messages',
                '--json-schema',
              ]),
            );
            expect(call?.args).not.toContain('--resume');
            expect(existsSync(paths.finished)).toBe(false);
            await expect
              .poll(
                () =>
                  readSteeringLog(target.projectDir, sessionId).some(
                    (entry) =>
                      entry.kind === 'event' &&
                      entry.type === 'queue_drained' &&
                      entry.data.seat === seat &&
                      entry.data.via === 'mid-call',
                  ),
                STEERING_WAIT,
              )
              .toBe(true);
            const state = loadState({ projectDir: target.projectDir, sessionId });
            expect(state?.messageQueue.filter(isQueuedMessagePendingFirstDelivery)).toHaveLength(0);
            const queuedId = state?.messageQueue.find((entry) => entry.text === message)?.id;
            expect(queuedId).toBeDefined();
            const log = readSteeringLog(target.projectDir, sessionId);
            const queuedIndex = log.findIndex(
              (entry) =>
                entry.kind === 'event' &&
                entry.type === 'message_queued' &&
                entry.data.id === queuedId,
            );
            const drainedIndex = log.findIndex(
              (entry) =>
                entry.kind === 'event' &&
                entry.type === 'queue_drained' &&
                entry.data.seat === seat,
            );
            expect(log[queuedIndex]).toMatchObject({
              data: { id: queuedId, seat, steerable: true },
            });
            expect(drainedIndex).toBeGreaterThan(queuedIndex);
            expect(log[drainedIndex]).toMatchObject({
              data: { ids: [queuedId], count: 1, seat, via: 'mid-call' },
            });
            expect(existsSync(paths.finished)).toBe(false);
            writeFileSync(paths.release, '');
          }
          await expect
            .poll(
              () =>
                readSteeringLog(target.projectDir, sessionId).some(
                  (entry) => entry.kind === 'event' && entry.type === 'workflow_complete',
                ),
              STEERING_WAIT,
            )
            .toBe(true);
          const state = loadState({ projectDir: target.projectDir, sessionId });
          expect(state).toMatchObject({
            phase: 'complete',
            reviewStatus: 'passed',
            tasks: [{ id: 'T001', status: 'done' }],
          });
          expect(state?.messageQueue.filter(isQueuedMessagePendingFirstDelivery)).toHaveLength(0);
          expect(
            readClaudePlannerSteers(target.tmpDir).filter((entry) => entry.kind === 'steer'),
          ).toHaveLength(2);
          expect(readdirSync(sessionsRoot(target.projectDir))).toEqual([sessionId]);
          child.write('\x11');
          await expect.poll(() => outcome, STEERING_WAIT).toBeDefined();
          expect(outcome?.exitCode, terminal).toBe(0);
        } catch (cause) {
          throw new Error(
            `Claude planner E2E failed; exit: ${outcome?.exitCode}\n${terminal.slice(-6000)}`,
            { cause },
          );
        } finally {
          for (const seat of ['plan', 'review'] as const)
            writeFileSync(claudePlannerSteerPaths(target.tmpDir, seat).release, '');
          try {
            if (outcome === undefined) await terminatePtyProcessGroup(child, exit.promise);
            await reapOrphanRunners(target.projectDir);
          } finally {
            dataListener.dispose();
            exitListener.dispose();
          }
        }
      },
    );
  } finally {
    restorePath?.();
    home.restore();
    cleanupTempDir(target.tmpDir);
  }
});
