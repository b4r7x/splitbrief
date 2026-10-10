import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { detectAvailableCliTools } from '../../../src/engine/detection/detect.js';
import { reapOrphanRunners } from '../../../src/engine/orchestrator/run/orphan-reaper.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome as createTrustHome } from '#testing/helpers/trust-home.js';
import type { PtyExitEvent, PtyProcess } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import {
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
} from './stop-continue-fixture.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const VerdictCallSchema = z.object({
  call: z.number(),
  pid: z.number(),
  cwd: z.string(),
  prompt: z.string(),
});

export function readReviewVerdictCalls(directory: string) {
  return readFileSync(join(directory, 'verdicts.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => VerdictCallSchema.parse(JSON.parse(line)));
}

type ReviewVerdictObservation = Readonly<{
  target: ReturnType<typeof createStopContinueFixture>;
  started: string;
  release: string;
  child: PtyProcess;
  terminal: () => string;
  outcome: () => PtyExitEvent | undefined;
}>;

export async function runReviewVerdictCli(
  answers: readonly [string, string],
  observe: (observation: ReviewVerdictObservation) => Promise<void>,
) {
  const target = createStopContinueFixture(
    () => `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
`,
    { isolation: 'none' },
  );
  const home = createTrustHome('e2e-review-verdict-home');
  let restorePath: (() => void) | undefined;
  const received = join(target.tmpDir, 'verdicts.jsonl');
  const started = join(target.tmpDir, 'review-started');
  const release = join(target.tmpDir, 'release-review');
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
if (!prompt.includes('Final Implementation Review')) throw new Error('Expected a verdict call');
const received = ${JSON.stringify(received)};
const call = fs.existsSync(received) ? fs.readFileSync(received, 'utf8').trim().split('\\n').length + 1 : 1;
fs.appendFileSync(received, JSON.stringify({ call, pid: process.pid, cwd: process.cwd(), prompt }) + '\\n');
const answers = ${JSON.stringify(answers)};
if (call > answers.length) throw new Error('Unexpected extra verdict call');
const finish = () => {
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: answers[call - 1] } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }));
};
if (call === 1) {
  const release = ${JSON.stringify(release)};
  const onRelease = () => {
    if (!fs.existsSync(release)) return;
    fs.unwatchFile(release, onRelease);
    finish();
  };
  fs.watchFile(release, { interval: 20 }, onRelease);
  fs.writeFileSync(${JSON.stringify(started)}, '');
  onRelease();
} else {
  finish();
}
`,
    );
    restorePath = activateSafeCliShimPath(bin);
    const config = loadConfig(target.projectDir).config;
    writeConfig(target.projectDir, {
      ...config,
      reviewer: { kind: 'cli', tool: 'codex', model: 'gpt-5-codex', contextLength: 200_000 },
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
      role: 'planner',
    });
    if (tools[0]?.diagnostic.state !== 'ready') {
      throw new Error(`Codex shim is not ready: ${JSON.stringify(tools[0]?.diagnostic)}`);
    }
    await rememberDetectedTools(target.projectDir, tools);
    const offline = join(target.tmpDir, 'offline.mjs');
    writeFileSync(
      offline,
      "globalThis.fetch = async () => { throw new Error('Network disabled in review verdict E2E'); };\n",
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
          terminal = (terminal + data).slice(-12_000);
        });
        try {
          await observe({
            target,
            started,
            release,
            child,
            terminal: () => terminal,
            outcome: () => outcome,
          });
        } catch (cause) {
          throw new Error(
            `Review verdict E2E failed; CLI exit: ${outcome?.exitCode}\n${terminal}`,
            {
              cause,
            },
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
}
