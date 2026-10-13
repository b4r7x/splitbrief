import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { readSessionLogWithDiagnostics } from '../../../src/core/sessions/log-reader.js';
import { detectAvailableCliTools } from '../../../src/engine/detection/detect.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import {
  cli,
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;
let trustHome: ReturnType<typeof useTrustHome> | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  restorePath?.();
  trustHome?.restore();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
  trustHome = undefined;
});

it('records raw model identities and one shared switch id when the CLI applies a fallback', async () => {
  fixture = createStopContinueFixture(() => '', { isolation: 'none' });
  const target = fixture;
  const primary = 'gpt-5-codex';
  const fallback = 'gpt-6.1-sol';
  trustHome = useTrustHome('e2e-seat-switch-identity-home');
  mkdirSync(join(trustHome.home, '.codex'), { recursive: true });
  writeFileSync(join(trustHome.home, '.codex', 'auth.json'), '{"fixture":true}\n');
  const binDir = join(target.tmpDir, 'bin');
  mkdirSync(binDir);
  writeFakeNodeCli(
    binDir,
    'codex',
    `const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex ${CLI_TOOL_CATALOG.codex.compatibility.testedVersion}');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  console.log('Logged in using ChatGPT');
  process.exit(0);
}
if (!args.includes('exec')) throw new Error('Unexpected invocation: ' + args.join(' '));
readFileSync(0, 'utf8');
const model = args[args.indexOf('--model') + 1];
if (model === ${JSON.stringify(primary)}) {
  console.log(JSON.stringify({ type: 'error', message: 'Insufficient Balance' }));
  process.exit(1);
}
if (model !== ${JSON.stringify(fallback)}) throw new Error('Unexpected model: ' + model);
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Implemented the greeting helper.' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 40 } }));`,
  );
  restorePath = activateSafeCliShimPath(binDir);
  writeConfig(target.projectDir, {
    ...loadConfig(target.projectDir).config,
    implementer: {
      kind: 'cli',
      tool: 'codex',
      model: primary,
      contextLength: 200_000,
      fallback: { tool: 'codex', model: fallback, effort: 'high' },
    },
  });
  const tools = await detectAvailableCliTools({
    projectDir: target.projectDir,
    tools: ['codex'],
    authChannels: { codex: 'session' },
    role: 'implementer',
  });
  expect(tools[0]?.diagnostic.state).toBe('ready');
  await rememberDetectedTools(target.projectDir, tools);
  const preload = join(target.tmpDir, 'offline.mjs');
  writeFileSync(
    preload,
    "globalThis.fetch = async () => { throw new Error('Network disabled'); };\n",
  );
  vi.stubEnv('NODE_OPTIONS', `--import=${preload}`);

  const run = await cli(target, ['start', 'smoke'], { timeoutMs: 90_000 });
  expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
  const sessions = readdirSync(sessionsRoot(target.projectDir));
  expect(sessions).toHaveLength(1);
  const ref = { projectDir: target.projectDir, sessionId: sessions[0] ?? '' };
  const state = loadState(ref);
  expect(state?.phase).toBe('complete');
  expect(state?.seatSwitches).toEqual([
    expect.objectContaining({
      switchId: expect.any(String),
      seat: 'build',
      from: 'OpenAI Codex CLI · GPT-5 Codex',
      to: 'OpenAI Codex CLI · GPT-6.1-Sol · high',
      fromSeat: { tool: 'codex', model: primary },
      toSeat: { tool: 'codex', model: fallback, effort: 'high' },
      auto: true,
    }),
  ]);
  const log = await readSessionLogWithDiagnostics(ref);
  const switches = log.entries.filter(
    (entry) => entry.kind === 'event' && entry.type === 'seat_switched',
  );
  expect(switches).toEqual([
    expect.objectContaining({
      data: expect.objectContaining({ switchId: state?.seatSwitches?.[0]?.switchId }),
    }),
  ]);
});
