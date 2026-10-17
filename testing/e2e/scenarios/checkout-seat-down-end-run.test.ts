import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { readEvidenceLedger } from '../../../src/core/evidence/ledger-storage.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { readRunRecord } from '../../../src/core/sessions/run-record-io.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { detectAvailableCliTools } from '../../../src/engine/detection/detect.js';
import { deriveSummaryView } from '../../../src/features/workflow/closed/view-model.js';
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
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

/** A file the brief does not declare, written by the halted call beside its declared file. */
const UNDECLARED_FILE = 'notes/greet.md';
const LATER_USER_FILE = 'later-user.txt';

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

/** Codex writes the brief's declared file and an undeclared one, then refuses on its account. */
function installCodex(binDir: string): void {
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
if (!args.includes('exec')) throw new Error('Unexpected codex invocation: ' + args.join(' '));
readFileSync(0, 'utf8');
mkdirSync('src', { recursive: true });
mkdirSync('notes', { recursive: true });
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
writeFileSync(${JSON.stringify(UNDECLARED_FILE)}, 'how greet reads\\n');
console.log(JSON.stringify({ type: 'error', message: 'Insufficient Balance' }));
process.exit(1);`,
  );
}

describe('e2e: End run after a Seat down halt in a checkout run', { timeout: 240_000 }, () => {
  it("books the halted brief's files up to the halt, not the user's later edits", async () => {
    fixture = createStopContinueFixture(() => '', { isolation: 'none' });
    const target = fixture;
    trustHome = createTrustHome('e2e-checkout-seat-down-home');
    mkdirSync(join(trustHome.home, '.codex'), { recursive: true });
    writeFileSync(join(trustHome.home, '.codex', 'auth.json'), '{"fixture":true}\n');
    const binDir = join(target.tmpDir, 'bin');
    mkdirSync(binDir);
    installCodex(binDir);
    restorePath = activateSafeCliShimPath(binDir);
    writeConfig(target.projectDir, {
      ...loadConfig(target.projectDir).config,
      implementer: { kind: 'cli', tool: 'codex', model: 'gpt-5-codex', contextLength: 200_000 },
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
      "globalThis.fetch = async () => { throw new Error('Network disabled in checkout seat down E2E'); };\n",
    );
    vi.stubEnv('NODE_OPTIONS', `--import=${offlinePreload}`);
    const options = { timeoutMs: 90_000, reapProjectDir: target.projectDir };

    const halted = await cli(target, ['start', 'smoke'], options);

    expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);
    expect(halted.stderr).toContain('Seat down (runner-usage-limit)');
    const [sessionId = ''] = readdirSync(sessionsRoot(target.projectDir));
    const ref = { projectDir: target.projectDir, sessionId };
    expect(loadState(ref)?.interruptedStep).toMatchObject({ source: 'seat' });
    expect(loadState(ref)?.interruptedStep).not.toHaveProperty('kept');
    writeFileSync(join(target.projectDir, LATER_USER_FILE), 'the user wrote this after the halt\n');

    const ended = await cli(target, ['continue', sessionId, '--action', 'end-run'], options);

    expect(ended.exitCode, `${ended.stdout}\n${ended.stderr}`).toBe(0);
    expect(loadState(ref)?.closed?.as).toBe('ended');
    expect(readEvidenceLedger(ref)?.tasks.find((task) => task.id === 'T001')).toMatchObject({
      status: 'in_progress',
      changedFiles: [UNDECLARED_FILE, GREET_FILE],
    });
    const view = deriveSummaryView({ record: readRunRecord(ref) });
    if (view === null) throw new Error('the ended run left no closed view');
    expect([...(view.files.changed ?? [])].sort()).toEqual([UNDECLARED_FILE, GREET_FILE]);
  });
});
