import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import XtermHeadless from '@xterm/headless';
import { expect, it } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool/catalog.js';
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
import { PTY_SUBMIT_INPUT } from '../../integration/cli/pty/contract.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import { readSteeringLog as readLog } from '../helpers/steer-e2e-workflow.js';
import {
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
} from '../helpers/stop-continue-fixture.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const VIEWPORT = { cols: 120, rows: 40 };
const RUN = { timeout: 120_000, interval: 20 };
const WAIT = { timeout: 45_000, interval: 20 };
const PAINT = { timeout: 15_000 };
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const LINE = '/steer fix the layout';
const REFUSAL = 'A command sends no image. Remove the command, then press ctrl+⏎.';

it('refuses a command line that holds an image and keeps the line and the image', {
  timeout: 200_000,
}, async () => {
  const target = createStopContinueFixture(() => '', { isolation: 'none' });
  const home = useTrustHome('e2e-steer-image-refused-home');
  const started = join(target.tmpDir, 'build-started');
  const finished = join(target.tmpDir, 'build-finished');
  const sigterm = join(target.tmpDir, 'build-sigterm');
  const calls = join(target.tmpDir, 'build-calls.txt');
  const release = join(target.tmpDir, 'release-build');
  const imagePath = join(realpathSync(target.tmpDir), 'reference.png');
  let restorePath: (() => void) | undefined;
  writeFileSync(imagePath, Buffer.from(PNG, 'base64'));
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
if (args.includes('read-only')) {
  const text = require('node:child_process').execFileSync(process.execPath, [${JSON.stringify(join(target.projectDir, 'tools', 'planner.mjs'))}], { input: prompt, encoding: 'utf8' });
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }));
  process.exit(0);
}
const calls = ${JSON.stringify(calls)};
const call = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\\n').filter(Boolean).length + 1 : 1;
fs.appendFileSync(calls, 'implement\\n');
if (call !== 1) throw new Error('The held BUILD call was repeated');
process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(sigterm)}, ''); process.exit(143); });
fs.writeFileSync(${JSON.stringify(started)}, '');
const finish = () => {
  fs.mkdirSync('src', { recursive: true });
  fs.writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
  fs.writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
  fs.writeFileSync(${JSON.stringify(finished)}, '');
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Layout fixed' } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }));
};
const release = ${JSON.stringify(release)};
if (fs.existsSync(release)) {
  finish();
} else {
  const timer = setInterval(() => {
    if (!fs.existsSync(release)) return;
    clearInterval(timer);
    finish();
  }, 10);
}
`,
    );
    restorePath = activateSafeCliShimPath(bin);
    const config = loadConfig(target.projectDir).config;
    writeConfig(target.projectDir, {
      ...config,
      planner: { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' },
      implementer: { kind: 'cli', tool: 'codex', model: 'gpt-5-codex', contextLength: 200_000 },
    });
    const env: Readonly<Record<string, string>> = {
      ...safeChildEnvironment(home.home, [bin]),
      XDG_STATE_HOME: target.stateHome,
    };
    await trustDeclaredRunners({
      projectDir: target.projectDir,
      config: loadConfig(target.projectDir).config,
      pathEnv: env.PATH ?? '',
    });
    const tools = await detectAvailableCliTools({
      projectDir: target.projectDir,
      tools: ['codex'],
    });
    expect(tools[0]?.diagnostic.state).toBe('ready');
    await rememberDetectedTools(target.projectDir, tools);
    const offline = join(target.tmpDir, 'offline.mjs');
    writeFileSync(
      offline,
      "globalThis.fetch = async () => { throw new Error('Network disabled in steer image E2E'); };\n",
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
          ...VIEWPORT,
          cwd: REPO_ROOT,
          env,
        },
      },
      async (child) => {
        const exit = Promise.withResolvers<PtyExitEvent>();
        let outcome: PtyExitEvent | undefined;
        const terminal = new XtermHeadless.Terminal({
          ...VIEWPORT,
          allowProposedApi: true,
          convertEol: true,
          scrollback: 0,
          logLevel: 'off',
        });
        const screen = () =>
          Array.from(
            { length: VIEWPORT.rows },
            (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? '',
          ).join('\n');
        const exitListener = child.onExit((event) => {
          outcome = event;
          exit.resolve(event);
        });
        const dataListener = child.onData((data) => terminal.write(data));
        try {
          await expect
            .poll(() => existsSync(started), { ...RUN, message: 'BUILD never started' })
            .toBe(true);
          const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
          if (sessionId === undefined) throw new Error('The held BUILD started without a session');
          expect(loadState({ projectDir: target.projectDir, sessionId })?.phase).toBe(
            'implementing',
          );
          await expect.poll(screen, WAIT).toContain('Message BUILD on T001');

          child.write(`${LINE} `);
          await expect.poll(screen, PAINT).toContain(LINE);
          child.write(`\u001b[200~"${imagePath}"\u001b[201~`);
          await expect.poll(screen, PAINT).toContain(`${LINE} [image #1]`);

          child.write(PTY_SUBMIT_INPUT);
          await expect.poll(screen, PAINT).toContain(REFUSAL);
          expect(screen()).toContain(`${LINE} [image #1]`);
          expect(existsSync(sigterm)).toBe(false);
          expect(existsSync(finished)).toBe(false);
          expect(loadState({ projectDir: target.projectDir, sessionId })?.phase).toBe(
            'implementing',
          );

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
          expect(loadState({ projectDir: target.projectDir, sessionId })?.phase).toBe('complete');
          expect(existsSync(sigterm)).toBe(false);
          expect(readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean)).toEqual([
            'implement',
          ]);

          child.write('\x11');
          await expect
            .poll(() => outcome, { ...WAIT, message: 'Quit did not exit after cleanup' })
            .toBeDefined();
          expect(outcome?.exitCode).toBe(0);
        } catch (cause) {
          throw new Error(`Steer image E2E failed; CLI exit: ${outcome?.exitCode}\n${screen()}`, {
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
