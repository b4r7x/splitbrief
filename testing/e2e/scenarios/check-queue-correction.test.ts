import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
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
import { passingVerdict } from '#testing/helpers/typed-planner.js';
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
const WAIT = { timeout: 45_000, interval: 20 };
const CORRECTED_MARKER = "export const RUN_MARKER = 'check-corrected';\n";
const ShimCallSchema = z.object({
  call: z.number(),
  cwd: z.string(),
  prompt: z.string(),
  greet: z.string(),
  marker: z.string(),
});
const CheckCallSchema = z.object({ buildCalls: z.number() });

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

it.each([
  { changesFiles: true, correction: 'QUEUE_CHECK_CORRECTION_CHANGE_THE_MARKER' },
  { changesFiles: false, correction: 'QUEUE_CHECK_CORRECTION_KEEP_THE_PUBLIC_API_UNCHANGED' },
])(
  'answers a message during checks with file changes: $changesFiles',
  async ({ changesFiles, correction }) => {
    const target = createStopContinueFixture(() => '', { isolation: 'none' });
    const home = useTrustHome('e2e-check-correction-home');
    let restorePath: (() => void) | undefined;
    const received = join(target.tmpDir, 'received.jsonl');
    const started = join(target.tmpDir, 'check-started');
    const release = join(target.tmpDir, 'release-check');
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
if (call === 1) {
  fs.mkdirSync('src', { recursive: true });
  fs.writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
  fs.writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
} else {
  if (call !== 2) throw new Error('Unexpected retry or escalation');
  if (!prompt.includes(${JSON.stringify(correction)})) throw new Error('Correction missing from brief');
  if (${changesFiles}) fs.writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(CORRECTED_MARKER)});
}
fs.appendFileSync(received, JSON.stringify({
  call, cwd: process.cwd(), prompt,
  greet: fs.readFileSync(${JSON.stringify(GREET_FILE)}, 'utf8'),
  marker: fs.readFileSync(${JSON.stringify(MARKER_FILE)}, 'utf8'),
}) + '\\n');
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Correction handled' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }));
`,
      );
      restorePath = activateSafeCliShimPath(bin);
      writeFileSync(
        join(target.projectDir, 'tools', 'check.mjs'),
        `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
const checks = ${JSON.stringify(checks)};
const buildCalls = readFileSync(${JSON.stringify(received)}, 'utf8').trim().split('\\n').length;
appendFileSync(checks, JSON.stringify({ buildCalls }) + '\\n');
if (buildCalls === 1) {
  const release = ${JSON.stringify(release)};
  writeFileSync(${JSON.stringify(started)}, '');
  while (!existsSync(release)) await delay(20);
}
`,
      );
      const reviewerFile = 'tools/check-correction-reviewer.mjs';
      writeFileSync(
        join(target.projectDir, reviewerFile),
        `for await (const chunk of process.stdin) void chunk;
process.stdout.write(${JSON.stringify(JSON.stringify(passingVerdict({ kind: 'task', taskIds: ['T001'], criterionIds: ['C1'] })))});
`,
      );
      const config = loadConfig(target.projectDir).config;
      const reviewer: typeof config.planner = {
        kind: 'shell',
        command: 'node',
        args: [`./${reviewerFile}`],
        outputFormat: 'text',
      };
      writeConfig(target.projectDir, {
        ...config,
        implementer: { kind: 'cli', tool: 'codex', model: 'gpt-5-codex', contextLength: 200_000 },
        reviewer,
        validation: { ...config.validation, testCommand: 'node ./tools/check.mjs' },
        workflow: { ...config.workflow, review: 'task', git: { createBranch: false } },
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
        "globalThis.fetch = async () => { throw new Error('Network disabled in check correction E2E'); };\n",
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
            env: { ...safeChildEnvironment(home.home, [bin]), XDG_STATE_HOME: target.stateHome },
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
            terminal = (terminal + data).slice(-16_000);
          });
          try {
            await expect
              .poll(() => existsSync(started), { ...WAIT, message: 'Checks never started' })
              .toBe(true);
            const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
            if (sessionId === undefined) throw new Error('Checks started without a run session');
            const ref = { projectDir: target.projectDir, sessionId };
            expect(loadState(ref)?.phase).toBe('validating-task');
            await expect.poll(() => terminal, WAIT).toContain('Message BUILD on T001');
            child.write(correction);
            await expect.poll(() => terminal, WAIT).toContain(correction);
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
            expect(
              loadState(ref)?.messageQueue.filter(isQueuedMessagePendingFirstDelivery),
            ).toHaveLength(1);
            expect(readFileSync(checks, 'utf8').trim().split('\n')).toHaveLength(1);
            expect(readFileSync(received, 'utf8').trim().split('\n')).toHaveLength(1);
            writeFileSync(release, '');
            await expect
              .poll(
                () =>
                  readLog(target.projectDir, sessionId).some(
                    (entry) => entry.kind === 'event' && entry.type === 'workflow_complete',
                  ),
                { ...WAIT, message: 'Workflow did not complete after the correction' },
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
            expect(log[queuedIndex]).toMatchObject({ taskId: 'T001', data: { seat: 'build' } });
            expect(log[drainedIndex]).toMatchObject({
              taskId: 'T001',
              data: { seat: 'build', count: 1 },
            });
            expect(
              log.filter((entry) => entry.kind === 'event' && entry.type === 'task_escalating'),
            ).toEqual([]);
            expect(
              log.filter((entry) => entry.kind === 'event' && entry.type === 'task_retry'),
            ).toEqual([]);
            expect(JSON.stringify(log)).not.toContain('no-staged-change');
            const state = loadState(ref);
            expect(state?.phase).toBe('complete');
            expect(state?.tasks).toMatchObject([{ id: 'T001', status: 'done' }]);
            expect(state?.pendingRecovery).toBeUndefined();
            expect(state?.messageQueue).toHaveLength(1);
            expect(state?.messageQueue.filter(isQueuedMessagePendingFirstDelivery)).toHaveLength(0);
            expect(state?.messageQueue[0]?.deliveredTo?.implementer).toBeDefined();
            const queuedId = state?.messageQueue[0]?.id;
            expect(log[queuedIndex]).toMatchObject({ data: { id: queuedId } });
            expect(log[drainedIndex]).toMatchObject({ data: { ids: [queuedId] } });
            const calls = readFileSync(received, 'utf8')
              .trim()
              .split('\n')
              .map((line) => ShimCallSchema.parse(JSON.parse(line)));
            expect(calls).toHaveLength(2);
            expect(calls[0]?.prompt).not.toContain(correction);
            expect(calls[1]?.prompt).toContain(correction);
            expect(calls.map((call) => call.cwd)).toEqual([
              realpathSync(target.projectDir),
              realpathSync(target.projectDir),
            ]);
            expect(calls.map((call) => call.greet)).toEqual([GREET_SOURCE, GREET_SOURCE]);
            expect(calls.map((call) => call.marker)).toEqual([
              MARKER_SOURCE,
              changesFiles ? CORRECTED_MARKER : MARKER_SOURCE,
            ]);
            const checkCalls = readFileSync(checks, 'utf8')
              .trim()
              .split('\n')
              .map((line) => CheckCallSchema.parse(JSON.parse(line)));
            expect(checkCalls.map((call) => call.buildCalls)).toEqual([1, 1, 2, 2, 2, 2]);
            expect(
              log.filter((entry) => entry.kind === 'event' && entry.type === 'checks_run'),
            ).toHaveLength(3);
            expect(readdirSync(sessionsRoot(target.projectDir))).toEqual([sessionId]);
            child.write('\x11');
            await expect
              .poll(() => outcome, { ...WAIT, message: 'Quit did not exit after cleanup' })
              .toBeDefined();
            expect(outcome?.exitCode, terminal).toBe(0);
          } catch (cause) {
            throw new Error(
              `Check correction E2E failed; CLI exit: ${outcome?.exitCode}\n${terminal}`,
              { cause },
            );
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
  },
);
