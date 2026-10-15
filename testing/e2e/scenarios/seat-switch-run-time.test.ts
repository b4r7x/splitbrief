import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { readRunRecord } from '../../../src/core/sessions/run-record-io.js';
import { detectAvailableCliTools } from '../../../src/engine/detection/detect.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
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

it('records how long a run ran through a CLI fallback, leaving out the halt', async () => {
  fixture = createStopContinueFixture(() => '', { isolation: 'none' });
  const target = fixture;
  const primary = 'gpt-5-codex';
  const fallback = 'gpt-6.1-sol';
  trustHome = useTrustHome('e2e-seat-switch-run-time-home');
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
      fallback: { tool: 'codex', model: fallback },
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
  const preload = join(target.tmpDir, 'clock.mjs');
  writeFileSync(
    preload,
    "const wallNow = Date.now;\nlet now = wallNow();\nDate.now = () => now = Math.max(now + 10, wallNow());\nglobalThis.fetch = async () => { throw new Error('Network disabled'); };\n",
  );
  vi.stubEnv('NODE_OPTIONS', `--import=${preload}`);

  const run = await cli(target, ['start', 'smoke'], { timeoutMs: 90_000 });
  expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
  const sessions = readdirSync(sessionsRoot(target.projectDir));
  expect(sessions).toHaveLength(1);
  const ref = { projectDir: target.projectDir, sessionId: sessions[0] ?? '' };
  expect(loadState(ref)?.phase).toBe('complete');
  const { events } = await readRunEvents(ref);
  const started = events.find((event) => event.type === 'workflow_started');
  const halted = events.find((event) => event.type === 'recovery_prompted');
  const resumed = events.find((event) => event.type === 'workflow_resumed');
  const finished = events.find((event) => event.type === 'workflow_complete');
  if (started === undefined || halted === undefined || finished === undefined) {
    throw new Error(`Run did not halt and finish: ${events.map((event) => event.type).join(', ')}`);
  }
  if (resumed?.type !== 'workflow_resumed') throw new Error('Run did not resume');
  expect(events.some((event) => event.type === 'seat_switched')).toBe(true);

  // The run ran until the halt, then from the seat switch's resume to its end.
  expect(readRunRecord(ref).summary?.activeTime).toBe(
    halted.ts - started.ts + finished.ts - (resumed.resumedAt ?? resumed.ts),
  );
});
