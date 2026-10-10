import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { isQueuedMessagePendingFirstDelivery } from '../../../src/core/queue-state.js';
import { SESSION_LOG_FILE, sessionDir, sessionsRoot } from '../../../src/core/paths.js';
import { SessionLogEntrySchema } from '../../../src/core/schemas/session-log.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { detectAvailableCliTools } from '../../../src/engine/detection/detect.js';
import { reapOrphanRunners } from '../../../src/engine/orchestrator/run/orphan-reaper.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import {
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
} from '../helpers/stop-continue-fixture.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const CORRECTION = 'QUEUE_CORRECTION_FOR_T001';
const WAIT = { timeout: 45_000, interval: 20 };

beforeAll(() => {
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc'], {
    cwd: REPO_ROOT,
    timeout: 120_000,
    stdio: 'pipe',
  });
}, 120_000);

function readLog(projectDir: string, sessionId: string) {
  const file = join(sessionDir(projectDir, sessionId), SESSION_LOG_FILE);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => SessionLogEntrySchema.parse(JSON.parse(line)));
}

it('delivers a queued BUILD message to the running brief before checks on the same run session', async () => {
  const target = createStopContinueFixture(() => '', { isolation: 'none' });
  const home = useTrustHome('e2e-build-queue-home');
  let restorePath: (() => void) | undefined;
  const received = join(target.tmpDir, 'received.jsonl');
  const started = join(target.tmpDir, 'build-started');
  const release = join(target.tmpDir, 'release-build');
  const corrected = join(target.tmpDir, 'build-corrected');
  const checks = join(target.tmpDir, 'checks.jsonl');
  try {
    mkdirSync(join(home.home, '.codex'), { recursive: true });
    writeFileSync(join(home.home, '.codex', 'auth.json'), '{"fixture":true}\n');
    const bin = join(target.tmpDir, 'bin');
    mkdirSync(bin);
    writeFakeNodeCli(
      bin,
      'codex',
      `
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex ${CLI_TOOL_CATALOG.codex.compatibility.testedVersion}'); process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  console.log('Logged in using ChatGPT'); process.exit(0);
}
if (!args.includes('exec')) throw new Error('Unexpected Codex invocation: ' + args.join(' '));
const prompt = fs.readFileSync(0, 'utf8');
const received = ${JSON.stringify(received)};
const call = fs.existsSync(received) ? fs.readFileSync(received, 'utf8').trim().split('\\n').length + 1 : 1;
fs.appendFileSync(received, JSON.stringify({ call, cwd: process.cwd(), prompt }) + '\\n');
fs.mkdirSync('src', { recursive: true });
fs.writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
fs.writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
const finish = () => {
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Greeting complete' } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }));
};
if (call === 1) {
  fs.writeFileSync(${JSON.stringify(started)}, '');
  const release = ${JSON.stringify(release)};
  const watcher = fs.watch(${JSON.stringify(target.tmpDir)}, () => {
    if (fs.existsSync(release)) { watcher.close(); finish(); }
  });
  if (fs.existsSync(release)) { watcher.close(); finish(); }
} else {
  if (!prompt.includes(${JSON.stringify(CORRECTION)})) throw new Error('Correction missing from running brief');
  fs.writeFileSync(${JSON.stringify(corrected)}, '');
  finish();
}
`,
    );
    restorePath = activateSafeCliShimPath(bin);
    writeFileSync(
      join(target.projectDir, 'tools', 'check.mjs'),
      `
import { appendFileSync, existsSync } from 'node:fs';
const corrected = existsSync(${JSON.stringify(corrected)});
appendFileSync(${JSON.stringify(checks)}, JSON.stringify({ corrected }) + '\\n');
if (!corrected) throw new Error('Checks ran before the BUILD correction pass');
`,
    );
    const config = loadConfig(target.projectDir).config;
    writeConfig(target.projectDir, {
      ...config,
      implementer: { kind: 'cli', tool: 'codex', model: 'gpt-5-codex', contextLength: 200_000 },
      validation: { ...config.validation, testCommand: 'node ./tools/check.mjs' },
      workflow: { ...config.workflow, git: { createBranch: false } },
    });
    await trustDeclaredRunners({
      projectDir: target.projectDir,
      config: loadConfig(target.projectDir).config,
    });
    const tools = await detectAvailableCliTools({
      projectDir: target.projectDir,
      tools: ['codex'],
      authChannels: { codex: 'session' },
      role: 'implementer',
    });
    expect(tools[0]?.diagnostic.state).toBe('ready');
    await rememberDetectedTools(target.projectDir, tools);
    const offline = join(target.tmpDir, 'offline.mjs');
    writeFileSync(
      offline,
      "globalThis.fetch = async () => { throw new Error('Network disabled in queue E2E'); };\n",
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
            .poll(() => existsSync(started), { ...WAIT, message: 'BUILD never started' })
            .toBe(true);
          const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
          if (sessionId === undefined) throw new Error('BUILD started without a run session');
          const before = loadState({ projectDir: target.projectDir, sessionId });
          expect(before?.phase).toBe('implementing');
          await expect.poll(() => terminal, WAIT).toContain('Message BUILD on T001');
          child.write(CORRECTION);
          await expect.poll(() => terminal, WAIT).toContain(CORRECTION);
          child.write('\r');
          await expect
            .poll(
              () =>
                readLog(target.projectDir, sessionId).some(
                  (entry) => entry.kind === 'event' && entry.type === 'message_queued',
                ),
              WAIT,
            )
            .toBe(true);
          const queuedState = loadState({ projectDir: target.projectDir, sessionId });
          expect(
            queuedState?.messageQueue.filter(isQueuedMessagePendingFirstDelivery),
          ).toHaveLength(1);
          expect(existsSync(checks)).toBe(false);
          writeFileSync(release, '');
          await expect
            .poll(
              () =>
                readLog(target.projectDir, sessionId).some(
                  (entry) => entry.kind === 'event' && entry.type === 'workflow_complete',
                ),
              { ...WAIT, message: 'Workflow did not complete' },
            )
            .toBe(true);
          const log = readLog(target.projectDir, sessionId);
          const queuedIndex = log.findIndex(
            (entry) => entry.kind === 'event' && entry.type === 'message_queued',
          );
          const drainedIndex = log.findIndex(
            (entry) => entry.kind === 'event' && entry.type === 'queue_drained',
          );
          expect(drainedIndex).toBeGreaterThan(queuedIndex);
          const queued = log[queuedIndex];
          const drained = log[drainedIndex];
          expect(queued).toMatchObject({
            taskId: 'T001',
            data: { seat: 'build' },
          });
          expect(queued).not.toMatchObject({ data: { steerable: true } });
          expect(drained).toMatchObject({ taskId: 'T001', data: { seat: 'build', count: 1 } });
          const state = loadState({ projectDir: target.projectDir, sessionId });
          expect(state?.phase).toBe('complete');
          expect(state?.tasks).toMatchObject([{ id: 'T001', status: 'done' }]);
          expect(state?.messageQueue).toHaveLength(1);
          expect(state?.messageQueue.filter(isQueuedMessagePendingFirstDelivery)).toHaveLength(0);
          expect(state?.messageQueue[0]?.deliveredTo?.implementer).toBeDefined();
          const queuedId = state?.messageQueue[0]?.id;
          expect(queued).toMatchObject({ data: { id: queuedId } });
          expect(drained).toMatchObject({ data: { ids: [queuedId] } });
          const calls = readFileSync(received, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
          expect(calls).toHaveLength(2);
          expect(calls[0].prompt).not.toContain(CORRECTION);
          expect(calls[1].prompt).toContain(CORRECTION);
          expect(calls.map((call) => call.cwd)).toEqual([calls[0].cwd, calls[0].cwd]);
          expect(readdirSync(sessionsRoot(target.projectDir))).toEqual([sessionId]);
          const checkCalls = readFileSync(checks, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
          expect(checkCalls).toHaveLength(2);
          expect(checkCalls.every((call) => call.corrected)).toBe(true);
          child.write('\x11');
          await expect
            .poll(() => outcome, { ...WAIT, message: 'Quit did not exit after cleanup' })
            .toBeDefined();
          expect(outcome?.exitCode, terminal).toBe(0);
        } catch (cause) {
          throw new Error(`Queue E2E failed; CLI exit: ${outcome?.exitCode}\n${terminal}`, {
            cause,
          });
        } finally {
          writeFileSync(release, '');
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
