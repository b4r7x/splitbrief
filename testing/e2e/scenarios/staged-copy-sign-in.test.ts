import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { evidenceLedgerPath } from '../../../src/core/evidence/ledger-storage.js';
import { sessionDir, sessionsRoot, SPLITBRIEF_DIR } from '../../../src/core/paths.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool/catalog.js';
import { deriveRunStatus } from '../../../src/core/sessions/run/status.js';
import type { SessionRef } from '../../../src/core/types/session-ref.js';
import { sandboxRoot, sandboxTempDir } from '../../../src/engine/runners/sandbox/state/paths.js';
import { prependPath, writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome as createTrustHome } from '#testing/helpers/trust-home.js';
import {
  cli,
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const COMMAND_CODE_STATUS = readFileSync(
  join(import.meta.dirname, '../../fixtures/command-code/status.txt'),
  'utf8',
)
  .split(/\r?\n/u)
  .slice(2)
  .join('\n');

const HOST_SIGN_IN = '{"apiKey":"command-code-e2e-sign-in"}\n';

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;
let home: ReturnType<typeof createTrustHome> | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  restorePath?.();
  home?.restore();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
  home = undefined;
});

interface Seen {
  path: string;
  isLink: boolean;
  content: string;
}

/** The BUILD call of a seat that spent its balance: it writes a partial file, then fails. */
const SEAT_DOWN_CALL = `
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
console.log(JSON.stringify({ type: 'result', subtype: 'error', error: 'Insufficient Balance' }));
process.exit(1);
`;

/** The BUILD call that records the sign-in file it was given, then writes the brief's files. */
function recordingCall(seen: string): string {
  return `
const auth = join(homedir(), '.commandcode', 'auth.json');
writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ path: auth, isLink: lstatSync(auth).isSymbolicLink(), content: readFileSync(auth, 'utf8') }));
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
console.log(JSON.stringify({ type: 'result', subtype: 'success', sessionId: 'command-code-staged-sign-in', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, durationMs: 10, finalText: 'Implemented the greeting.' }));
`;
}

/**
 * A staged-copy project whose BUILD seat is a fake Command Code, in a throwaway home that holds
 * a Command Code sign-in, with no network and with the temp folders of the run in its own folder.
 * `buildCall` is the body of a BUILD call.
 */
function commandCodeProject(buildCall: (seen: string) => string): {
  target: StopContinueFixture;
  seen: string;
  hostAuth: string;
  temp: string;
} {
  const target = createStopContinueFixture(undefined, { isolation: 'staged-copy' });
  fixture = target;
  const trustHome = createTrustHome('e2e-staged-copy-sign-in-home');
  home = trustHome;
  const hostAuth = join(trustHome.home, '.commandcode', 'auth.json');
  mkdirSync(join(trustHome.home, '.commandcode'), { recursive: true, mode: 0o700 });
  writeFileSync(hostAuth, HOST_SIGN_IN, { mode: 0o600 });
  const offline = join(target.tmpDir, 'offline.mjs');
  writeFileSync(
    offline,
    "globalThis.fetch = async () => { throw new Error('Network disabled in the staged-copy sign-in E2E'); };\n",
  );
  vi.stubEnv('NODE_OPTIONS', `--import=${offline}`);
  const seen = join(target.tmpDir, 'command-code-seen.json');
  const bin = join(target.tmpDir, 'bin');
  mkdirSync(bin);
  writeFakeNodeCli(
    bin,
    'cmd',
    `
const { lstatSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('${CLI_TOOL_CATALOG['command-code'].compatibility.testedVersion}');
  process.exit(0);
}
if (args[0] === 'status') {
  console.log(${JSON.stringify(COMMAND_CODE_STATUS)});
  process.exit(0);
}
if (args.includes('--help')) {
  console.log('Command Code fixture');
  process.exit(0);
}
if (!args.includes('-p')) process.exit(1);
readFileSync(0, 'utf8');
${buildCall(seen)}`,
  );
  restorePath = prependPath(bin);
  const config = loadConfig(target.projectDir).config;
  writeConfig(target.projectDir, {
    ...config,
    implementer: { kind: 'cli', tool: 'command-code', contextLength: 200_000 },
  });
  // After the fake seat: its launcher is made once per file and outlives this fixture.
  const temp = join(target.tmpDir, 'tmp');
  mkdirSync(temp);
  vi.stubEnv('TMPDIR', temp);
  return { target, seen, hostAuth, temp };
}

/** The staged workspace of the one run of the project, and its sandbox folder. */
function stagedWorkspace(target: StopContinueFixture): {
  ref: SessionRef;
  workspace: string;
  sandbox: string;
} {
  // The run works in the real path of the project folder.
  const projectDir = realpathSync(target.projectDir);
  const [sessionId] = readdirSync(sessionsRoot(projectDir));
  if (sessionId === undefined) throw new Error('the run left no session');
  const [leaf] = readdirSync(sessionDir(projectDir, sessionId)).filter((name) =>
    name.startsWith('stage-'),
  );
  if (leaf === undefined) throw new Error('the run left no staged copy');
  const workspace = join(sessionDir(projectDir, sessionId), leaf, 'workspace');
  return {
    ref: { projectDir, sessionId },
    workspace,
    sandbox: join(workspace, SPLITBRIEF_DIR, 'sandbox'),
  };
}

function sandboxTempFolders(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith('sb-'));
}

function signInFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((entry) =>
    entry.endsWith('auth.json'),
  );
}

describe('e2e: a staged-copy run with a copied sign-in', { timeout: 120_000 }, () => {
  it('removes the sign-in copy from the run workspace when the run ends', async () => {
    const { target, seen, hostAuth } = commandCodeProject(recordingCall);

    const start = await cli(target, ['start', 'smoke']);
    expect(start.exitCode, `${start.stdout}\n${start.stderr}`).toBe(0);

    const { workspace, sandbox } = stagedWorkspace(target);
    const record = JSON.parse(readFileSync(seen, 'utf8')) as Seen;

    expect(record.path.startsWith(`${sandbox}/`), record.path).toBe(true);
    expect(record.isLink).toBe(false);
    expect(record.content).toBe(HOST_SIGN_IN);
    expect(existsSync(join(workspace, GREET_FILE))).toBe(true);
    expect(existsSync(record.path)).toBe(false);
    expect(signInFilesUnder(sandbox)).toEqual([]);
    expect(readFileSync(hostAuth, 'utf8')).toBe(HOST_SIGN_IN);
  });

  it('removes the sign-in copy and the temp folders when Skip after a seat went down finishes the run', async () => {
    const { target, hostAuth, temp } = commandCodeProject(() => SEAT_DOWN_CALL);

    const halted = await cli(target, ['start', 'smoke']);
    expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);

    const { ref, workspace, sandbox } = stagedWorkspace(target);
    expect(readState(target, ref.sessionId).pendingRecovery).toMatchObject({
      reason: 'runner-usage-limit',
      availableActions: expect.arrayContaining(['skip-current-task']),
    });
    expect(signInFilesUnder(sandbox)).toEqual([
      join('implementer', 'command-code', 'home', '.commandcode', 'auth.json'),
    ]);
    const kept = sandboxTempFolders(temp);
    expect(kept).toContain(
      basename(sandboxTempDir(sandboxRoot(workspace, 'implementer', 'command-code'))),
    );

    const skipped = await cli(target, ['continue', ref.sessionId, '--action', 'skip']);
    expect(skipped.exitCode, `${skipped.stdout}\n${skipped.stderr}`).toBe(0);

    const state = readState(target, ref.sessionId);
    expect(state.tasks.map((task) => task.status)).toEqual(['skipped']);
    expect(deriveRunStatus({ state, liveness: 'not-alive', reviewNone: false }).kind).toBe(
      'ready-to-apply',
    );
    expect(existsSync(join(workspace, MARKER_FILE))).toBe(false);
    expect(signInFilesUnder(sandbox)).toEqual([]);
    expect(sandboxTempFolders(temp).filter((name) => kept.includes(name))).toEqual([]);
    expect(readFileSync(hostAuth, 'utf8')).toBe(HOST_SIGN_IN);
  });

  it('refuses Skip after the project folder moved, and the same Skip finishes the run after the move back', async () => {
    const { target, hostAuth, temp } = commandCodeProject(() => SEAT_DOWN_CALL);

    const halted = await cli(target, ['start', 'smoke']);
    expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);

    const { ref, workspace, sandbox } = stagedWorkspace(target);
    const kept = sandboxTempFolders(temp);
    const moved = { ...target, projectDir: join(target.tmpDir, 'moved-project') };
    renameSync(target.projectDir, moved.projectDir);
    const ledger = evidenceLedgerPath({ ...ref, projectDir: moved.projectDir });
    const ledgerBytes = () => (existsSync(ledger) ? readFileSync(ledger, 'utf8') : null);
    const ledgerBefore = ledgerBytes();

    const refused = await cli(moved, ['continue', ref.sessionId, '--action', 'skip']);

    expect(refused.exitCode, `${refused.stdout}\n${refused.stderr}`).toBe(1);
    expect(refused.stderr).toContain(
      `This run started in ${ref.projectDir}. Move the project back to that folder to continue the run, or end the run.`,
    );
    expect(refused.stderr).not.toContain('no such file or directory');
    const halt = readState(moved, ref.sessionId);
    expect(halt.tasks.map((task) => task.status)).toEqual(['in_progress']);
    expect(halt.pendingRecovery).toMatchObject({ status: 'awaiting-user' });
    expect(halt.pendingRecovery?.selectedAction).toBeUndefined();
    expect(ledgerBytes()).toBe(ledgerBefore);

    renameSync(moved.projectDir, target.projectDir);
    const skipped = await cli(target, ['continue', ref.sessionId, '--action', 'skip']);
    expect(skipped.exitCode, `${skipped.stdout}\n${skipped.stderr}`).toBe(0);

    const state = readState(target, ref.sessionId);
    expect(state.tasks.map((task) => task.status)).toEqual(['skipped']);
    expect(deriveRunStatus({ state, liveness: 'not-alive', reviewNone: false }).kind).toBe(
      'ready-to-apply',
    );
    expect(existsSync(join(workspace, MARKER_FILE))).toBe(false);
    expect(signInFilesUnder(sandbox)).toEqual([]);
    expect(sandboxTempFolders(temp).filter((name) => kept.includes(name))).toEqual([]);
    expect(readFileSync(hostAuth, 'utf8')).toBe(HOST_SIGN_IN);
  });
});
