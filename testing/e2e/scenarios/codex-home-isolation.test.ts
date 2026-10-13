import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { loadState } from '../../../src/core/state/persistence.js';
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

it("keeps a codex BUILD seat's sessions out of the user's codex home and keeps its token refresh", async () => {
  fixture = createStopContinueFixture(() => '', { isolation: 'none' });
  const target = fixture;
  trustHome = useTrustHome('e2e-codex-home-isolation');
  const hostCodex = join(trustHome.home, '.codex');
  mkdirSync(join(hostCodex, 'sessions'), { recursive: true });
  writeFileSync(join(hostCodex, 'auth.json'), '{"tokens":{"refresh_token":"before-build"}}\n');
  writeFileSync(join(hostCodex, 'config.toml'), 'model = "gpt-5"\n');
  writeFileSync(join(hostCodex, 'sessions', 'user-rollout.jsonl'), '{}\n');
  const seen = join(target.tmpDir, 'codex-home-seen.json');
  const binDir = join(target.tmpDir, 'bin');
  mkdirSync(binDir);
  writeFakeNodeCli(
    binDir,
    'codex',
    `const fs = require('node:fs');
const path = require('node:path');
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
fs.readFileSync(0, 'utf8');
const codexHome = path.join(process.env.HOME, '.codex');
fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify(fs.readdirSync(codexHome).sort()));
JSON.parse(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8'));
fs.writeFileSync(path.join(codexHome, 'auth.json'), '{"tokens":{"refresh_token":"rotated-by-build"}}\\n');
fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(codexHome, 'sessions', 'rollout-build.jsonl'), '{}\\n');
fs.mkdirSync('src', { recursive: true });
fs.writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
fs.writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Implemented the greeting helper.' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 40 } }));`,
  );
  restorePath = activateSafeCliShimPath(binDir);
  writeConfig(target.projectDir, {
    ...loadConfig(target.projectDir).config,
    implementer: { kind: 'cli', tool: 'codex', model: 'gpt-5-codex', contextLength: 200_000 },
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
  expect(loadState({ projectDir: target.projectDir, sessionId: sessions[0] ?? '' })?.phase).toBe(
    'complete',
  );

  expect(JSON.parse(readFileSync(seen, 'utf8'))).toEqual(['auth.json']);
  expect(readdirSync(hostCodex).toSorted()).toEqual(['auth.json', 'config.toml', 'sessions']);
  expect(readdirSync(join(hostCodex, 'sessions'))).toEqual(['user-rollout.jsonl']);
  expect(readFileSync(join(hostCodex, 'auth.json'), 'utf8')).toBe(
    '{"tokens":{"refresh_token":"rotated-by-build"}}\n',
  );
});
