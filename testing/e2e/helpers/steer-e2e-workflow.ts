import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { SESSION_LOG_FILE, sessionDir } from '../../../src/core/paths.js';
import type { CliImplementerConfig } from '../../../src/core/schemas/implementer-config.js';
import { SessionLogEntrySchema } from '../../../src/core/schemas/session-log.js';
import { detectAvailableCliTools } from '../../../src/engine/detection/detect.js';
import { reapOrphanRunners } from '../../../src/engine/orchestrator/run/orphan-reaper.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome as createTrustHome } from '#testing/helpers/trust-home.js';
import type { PtyExitEvent, PtyProcess } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import { createStopContinueFixture } from './stop-continue-fixture.js';
import {
  installClaudeSteeringShim,
  installCodexRefusalShim,
  installOpencodeSteeringShim,
  steeringPaths,
  type SteeringTool,
} from './steer-e2e-shims.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
export const STEERING_WAIT = { timeout: 45_000, interval: 20 };

const CaptureSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('call'),
    tool: z.string(),
    pid: z.number(),
    text: z.string(),
    args: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('steer'),
    tool: z.string(),
    pid: z.number(),
    text: z.string(),
    channel: z.enum(['stdin', 'http']),
    beforeFinish: z.boolean(),
  }),
  z.object({ kind: z.literal('refusal'), tool: z.string(), pid: z.number(), text: z.string() }),
  z.object({ kind: z.literal('finished'), tool: z.string(), pid: z.number() }),
]);

export function buildSteeringCli() {
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc'], {
    cwd: REPO_ROOT,
    timeout: 120_000,
    stdio: 'pipe',
  });
}

function readLines(file: string): unknown[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function readSteeringCaptures(directory: string) {
  return readLines(join(directory, 'calls.jsonl')).map((value) => CaptureSchema.parse(value));
}

export function readSteeringLog(projectDir: string, sessionId: string) {
  return readLines(join(sessionDir(projectDir, sessionId), SESSION_LOG_FILE)).map((value) => {
    const entry = SessionLogEntrySchema.parse(value);
    return entry.kind === 'event'
      ? { ...entry, data: z.record(z.string(), z.unknown()).parse(entry.data) }
      : entry;
  });
}

type SteeringObservation = Readonly<{
  target: ReturnType<typeof createStopContinueFixture>;
  child: PtyProcess;
  terminal: () => string;
  outcome: () => PtyExitEvent | undefined;
}>;

export async function runSteeringCli(
  implementer: CliImplementerConfig & { tool: SteeringTool },
  observe: (observation: SteeringObservation) => Promise<void>,
) {
  const target = createStopContinueFixture(() => '', { isolation: 'none' });
  const home = createTrustHome('steer-e2e-home');
  let restorePath: (() => void) | undefined;
  try {
    mkdirSync(join(home.home, '.claude'), { recursive: true });
    writeFileSync(join(home.home, '.claude', '.credentials.json'), '{"fixture":true}\n');
    mkdirSync(join(home.home, '.codex'), { recursive: true });
    writeFileSync(join(home.home, '.codex', 'auth.json'), '{"fixture":true}\n');
    mkdirSync(join(home.home, '.config', 'opencode'), { recursive: true });
    writeFileSync(join(home.home, '.config', 'opencode', 'auth.json'), '{"fixture":true}\n');
    const bin = join(target.tmpDir, 'bin');
    mkdirSync(bin);
    installClaudeSteeringShim(target.tmpDir, bin);
    installCodexRefusalShim(target.tmpDir, bin);
    installOpencodeSteeringShim(target.tmpDir, bin);
    restorePath = activateSafeCliShimPath(bin);
    const config = loadConfig(target.projectDir).config;
    writeConfig(target.projectDir, {
      ...config,
      implementer,
      workflow: { ...config.workflow, git: { createBranch: false } },
    });
    await trustDeclaredRunners({
      projectDir: target.projectDir,
      config: loadConfig(target.projectDir).config,
    });
    const tools = await detectAvailableCliTools({
      projectDir: target.projectDir,
      tools: ['claude-code', 'opencode', 'codex'],
      authChannels: { 'claude-code': 'session', opencode: 'provider-dependent', codex: 'session' },
      role: 'implementer',
    });
    for (const tool of tools) {
      if (tool.diagnostic.state !== 'ready')
        throw new Error(`${tool.tool} shim is not ready: ${JSON.stringify(tool.diagnostic)}`);
    }
    await rememberDetectedTools(target.projectDir, tools);
    const offline = join(target.tmpDir, 'offline.mjs');
    writeFileSync(
      offline,
      `const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === '127.0.0.1') return nativeFetch(input, options);
  throw new Error('Network disabled in steering E2E');
};\n`,
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
          terminal += data;
        });
        try {
          await observe({ target, child, terminal: () => terminal, outcome: () => outcome });
        } catch (cause) {
          throw new Error(`Steering E2E failed; CLI exit: ${outcome?.exitCode}\n${terminal}`, {
            cause,
          });
        } finally {
          for (const tool of ['claude-code', 'opencode'] as const)
            writeFileSync(steeringPaths(target.tmpDir, tool).release, '');
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
