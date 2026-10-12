import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import XtermHeadless from '@xterm/headless';
import { beforeAll, expect, it } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { isQueuedMessagePendingFirstDelivery } from '../../../src/core/queue-state.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { loadState } from '../../../src/core/state/persistence.js';
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
import { buildSteeringCli, readSteeringLog, STEERING_WAIT } from '../helpers/steer-e2e-workflow.js';
import { createStopContinueFixture } from '../helpers/stop-continue-fixture.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const MESSAGE = 'Keep the pending BUILD correction';
const COLS = 120;
const ROWS = 40;

beforeAll(buildSteeringCli, 120_000);

it('ends a BUILD run without a queue byline and keeps its pending-message history', async () => {
  const target = createStopContinueFixture(() => '', { isolation: 'none' });
  const home = useTrustHome('closed-queue-home');
  const started = join(target.tmpDir, 'build-started');
  let restorePath: (() => void) | undefined;
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
fs.readFileSync(0, 'utf8');
fs.writeFileSync(${JSON.stringify(started)}, '');
setInterval(() => {}, 1000);
`,
    );
    restorePath = activateSafeCliShimPath(bin);
    const config = loadConfig(target.projectDir).config;
    writeConfig(target.projectDir, {
      ...config,
      implementer: { kind: 'cli', tool: 'codex', model: 'gpt-5-codex', contextLength: 200_000 },
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
      "globalThis.fetch = async () => { throw new Error('Network disabled in closed queue E2E'); };\n",
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
          cols: COLS,
          rows: ROWS,
          cwd: REPO_ROOT,
          env: { ...safeChildEnvironment(home.home, [bin]), XDG_STATE_HOME: target.stateHome },
        },
      },
      async (child) => {
        const exit = Promise.withResolvers<PtyExitEvent>();
        let outcome: PtyExitEvent | undefined;
        const terminal = new XtermHeadless.Terminal({
          cols: COLS,
          rows: ROWS,
          allowProposedApi: true,
          convertEol: true,
          scrollback: 0,
          logLevel: 'off',
        });
        const screen = () =>
          Array.from(
            { length: ROWS },
            (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? '',
          ).join('\n');
        const byline = () => screen().split('\n').at(-1)?.trim() ?? '';
        const exitListener = child.onExit((event) => {
          outcome = event;
          exit.resolve(event);
        });
        const dataListener = child.onData((data) => {
          terminal.write(data);
        });
        try {
          await expect.poll(() => existsSync(started), STEERING_WAIT).toBe(true);
          const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
          if (sessionId === undefined) throw new Error('BUILD started without a run session');
          const ref = { projectDir: target.projectDir, sessionId };
          await expect.poll(screen, STEERING_WAIT).toContain('Message BUILD on T001');
          child.write(MESSAGE);
          await expect.poll(screen, STEERING_WAIT).toContain(MESSAGE);
          child.write('\r');
          await expect.poll(screen, STEERING_WAIT).toContain('1 queued for BUILD on T001');
          const queued = loadState(ref)?.messageQueue;
          expect(queued?.filter(isQueuedMessagePendingFirstDelivery)).toHaveLength(1);

          child.write('/end');
          await expect.poll(screen, STEERING_WAIT).toContain('/end');
          child.write('\r');
          await expect.poll(() => loadState(ref)?.closed?.as, STEERING_WAIT).toBe('ended');
          await expect.poll(byline, STEERING_WAIT).toBe('Ended · esc home');
          expect(screen()).toContain('Queued');
          expect(screen()).toContain(MESSAGE);
          expect(loadState(ref)?.messageQueue).toEqual(queued);
          expect(
            readSteeringLog(target.projectDir, sessionId).filter(
              (entry) => entry.kind === 'event' && entry.type === 'message_queued',
            ),
          ).toMatchObject([{ data: { id: queued?.[0]?.id, preview: MESSAGE, seat: 'build' } }]);

          child.write('\t');
          await expect.poll(screen, STEERING_WAIT).not.toContain('Session options');
          expect(byline()).toBe('Ended · esc home');
          child.write('/queue show');
          await expect.poll(screen, STEERING_WAIT).toContain('/queue show');
          child.write('\r');
          await expect.poll(screen, STEERING_WAIT).toContain('1 queued for BUILD');
          expect(byline()).toBe('Ended · esc home');
          expect(loadState(ref)?.messageQueue).toEqual(queued);
          child.write('\x11');
          await expect.poll(() => outcome, STEERING_WAIT).toBeDefined();
          expect(outcome?.exitCode, screen()).toBe(0);
        } catch (cause) {
          throw new Error(`Closed queue E2E failed; CLI exit: ${outcome?.exitCode}\n${screen()}`, {
            cause,
          });
        } finally {
          try {
            if (outcome === undefined) await terminatePtyProcessGroup(child, exit.promise);
            await reapOrphanRunners(target.projectDir);
          } finally {
            dataListener.dispose();
            exitListener.dispose();
            terminal.dispose();
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
