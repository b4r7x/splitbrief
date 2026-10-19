import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { readEvidenceLedger } from '../../../src/core/evidence/ledger-storage.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { detectAvailableCliTools } from '../../../src/engine/detection/detect.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome as createTrustHome } from '#testing/helpers/trust-home.js';
import {
  cli,
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const BURNED_REFRESH =
  'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.';

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;
let trustHome: ReturnType<typeof createTrustHome> | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  restorePath?.();
  trustHome?.restore();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
  trustHome = undefined;
});

/** Codex writes the brief's files on its first call, then its sign-in is gone on the retry. */
function installCodex(binDir: string, callsPath: string): void {
  writeFakeNodeCli(
    binDir,
    'codex',
    `const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex ${CLI_TOOL_CATALOG.codex.compatibility.testedVersion}');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  console.log('Logged in using ChatGPT');
  process.exit(0);
}
if (!args.includes('exec')) throw new Error('Unexpected codex invocation: ' + args.join(' '));
fs.readFileSync(0, 'utf8');
const callsPath = ${JSON.stringify(callsPath)};
const call = fs.existsSync(callsPath) ? Number(fs.readFileSync(callsPath, 'utf8')) + 1 : 1;
fs.writeFileSync(callsPath, String(call));
if (call === 1) {
  fs.mkdirSync('src', { recursive: true });
  fs.writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
  fs.writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Greeting complete' } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }));
  process.exit(0);
}
console.log(JSON.stringify({ type: 'error', message: ${JSON.stringify(BURNED_REFRESH)} }));
console.log(JSON.stringify({ type: 'turn.failed', error: { message: ${JSON.stringify(BURNED_REFRESH)} } }));
process.exit(1);`,
  );
}

describe('e2e: End run after a checkout brief halted and had its files put back', {
  timeout: 240_000,
}, () => {
  it('does not say the files it wrote are still on disk', async () => {
    fixture = createStopContinueFixture(() => '', { isolation: 'none' });
    const target = fixture;
    trustHome = createTrustHome('e2e-checkout-halt-restore-home');
    mkdirSync(join(trustHome.home, '.codex'), { recursive: true });
    writeFileSync(join(trustHome.home, '.codex', 'auth.json'), '{"fixture":true}\n');
    const binDir = join(target.tmpDir, 'bin');
    mkdirSync(binDir);
    installCodex(binDir, join(target.tmpDir, 'codex-calls'));
    restorePath = activateSafeCliShimPath(binDir);
    const failingCheck = join(target.tmpDir, 'failing-check.mjs');
    writeFileSync(failingCheck, "console.error('greet is wrong');\nprocess.exit(1);\n");
    const config = loadConfig(target.projectDir).config;
    writeConfig(target.projectDir, {
      ...config,
      implementer: { kind: 'cli', tool: 'codex', model: 'gpt-5-codex', contextLength: 200_000 },
      validation: { ...config.validation, testCommand: `node ${failingCheck}` },
      workflow: { ...config.workflow, review: 'task' },
    });
    const cliTools = await detectAvailableCliTools({
      projectDir: target.projectDir,
      tools: ['codex'],
      authChannels: { codex: 'session' },
      role: 'implementer',
    });
    expect(cliTools.map((tool) => [tool.tool, tool.diagnostic.state])).toEqual([
      ['codex', 'ready'],
    ]);
    await rememberDetectedTools(target.projectDir, cliTools);
    const offlinePreload = join(target.tmpDir, 'offline.mjs');
    writeFileSync(
      offlinePreload,
      "globalThis.fetch = async () => { throw new Error('Network disabled in checkout halt restore E2E'); };\n",
    );
    vi.stubEnv('NODE_OPTIONS', `--import=${offlinePreload}`);
    const options = { timeoutMs: 90_000, reapProjectDir: target.projectDir };

    const halted = await cli(target, ['start', 'smoke'], options);

    expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);
    expect(halted.stderr).toMatch(/Restored 2 failing task changes/);
    expect(existsSync(join(target.projectDir, GREET_FILE))).toBe(false);
    expect(existsSync(join(target.projectDir, MARKER_FILE))).toBe(false);
    const [sessionId = ''] = readdirSync(sessionsRoot(target.projectDir));
    const ref = { projectDir: target.projectDir, sessionId };

    const ended = await cli(target, ['continue', sessionId, '--action', 'end-run'], options);

    expect(ended.exitCode, `${ended.stdout}\n${ended.stderr}`).toBe(0);
    expect(loadState(ref)?.closed?.as).toBe('ended');
    expect(ended.stdout).toContain(`Run ${sessionId} closed.`);
    expect(ended.stdout).not.toContain('still on disk');
    expect(ended.stderr).not.toContain('its changes are already there');
    expect(readEvidenceLedger(ref)?.tasks.find((task) => task.id === 'T001')).toMatchObject({
      status: 'in_progress',
      changedFiles: [],
    });
  });
});
