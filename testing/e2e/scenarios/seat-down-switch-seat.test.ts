import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { CONFIG_RELATIVE_PATH } from '../../../src/core/config/load/document.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { detectAvailableCliTools } from '../../../src/engine/detection/detect.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome as createTrustHome } from '#testing/helpers/trust-home.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import {
  cli,
  continueWithCorrection,
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const PRIMARY_MODEL = 'gpt-5-codex';
const SWITCHED_MODEL = 'sonnet';
let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;
let trustHome: ReturnType<typeof createTrustHome> | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  restorePath?.();
  trustHome?.restore();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
  trustHome = undefined;
});

const WRITE_BOTH_FILES = `mkdirSync('src', { recursive: true });
  writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
  writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});`;

/**
 * Codex refuses on its account; Claude builds. With `haltedCallWrote` codex writes both files
 * before it refuses, and Claude finds them done and writes nothing.
 */
function installShims(
  binDir: string,
  codexCalls: string,
  claudeCalls: string,
  haltedCallWrote: boolean,
): void {
  writeFakeNodeCli(
    binDir,
    'codex',
    `const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
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
appendFileSync(${JSON.stringify(codexCalls)}, JSON.stringify({ model: args.includes('--model') ? args[args.indexOf('--model') + 1] : null }) + '\\n');
${haltedCallWrote ? WRITE_BOTH_FILES : ''}
console.log(JSON.stringify({ type: 'error', message: 'Insufficient Balance' }));
process.exit(1);`,
  );
  writeFakeNodeCli(
    binDir,
    'claude',
    `const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('claude 2.1.296');
  process.exit(0);
}
if (args[0] === 'auth') {
  console.log(JSON.stringify({ loggedIn: true }));
  process.exit(0);
}
if (args[0] !== '-p') throw new Error('Unexpected claude invocation: ' + args.join(' '));
const emit = (entry) => console.log(JSON.stringify(entry));
const build = (prompt) => {
  appendFileSync(${JSON.stringify(claudeCalls)}, JSON.stringify({ model: args.includes('--model') ? args[args.indexOf('--model') + 1] : null, prompt }) + '\\n');
  ${haltedCallWrote ? '' : WRITE_BOTH_FILES}
  emit({ type: 'system', subtype: 'init', session_id: 'seat-switch-claude' });
  emit({ type: 'assistant', session_id: 'seat-switch-claude', message: { content: [{ type: 'text', text: 'Implemented the greeting helper.' }] } });
  emit({ type: 'result', result: 'Implemented the greeting helper.', session_id: 'seat-switch-claude', usage: { input_tokens: 100, output_tokens: 40 } });
};
if (args.includes('--input-format')) {
  const lines = require('node:readline').createInterface({ input: process.stdin });
  lines.once('line', (line) => {
    const input = JSON.parse(line);
    const content = input.message.content;
    build(typeof content === 'string' ? content : JSON.stringify(content));
    lines.close();
    process.stdin.destroy();
  });
} else {
  build(readFileSync(0, 'utf8'));
}`,
  );
}

async function codexHaltFixture(haltedCallWrote = false) {
  fixture = createStopContinueFixture(() => '', { isolation: 'none' });
  const target = fixture;
  trustHome = createTrustHome('e2e-seat-switch-home');
  mkdirSync(join(trustHome.home, '.codex'), { recursive: true });
  writeFileSync(join(trustHome.home, '.codex', 'auth.json'), '{"fixture":true}\n');
  mkdirSync(join(trustHome.home, '.claude'), { recursive: true });
  writeFileSync(join(trustHome.home, '.claude', '.credentials.json'), '{"fixture":true}\n');
  const binDir = join(target.tmpDir, 'bin');
  mkdirSync(binDir);
  const codexCalls = join(target.tmpDir, 'codex-calls.jsonl');
  const claudeCalls = join(target.tmpDir, 'claude-calls.jsonl');
  installShims(binDir, codexCalls, claudeCalls, haltedCallWrote);
  restorePath = activateSafeCliShimPath(binDir);

  const config = loadConfig(target.projectDir).config;
  writeConfig(target.projectDir, {
    ...config,
    implementer: { kind: 'cli', tool: 'codex', model: PRIMARY_MODEL, contextLength: 200_000 },
  });
  expect(loadConfig(target.projectDir).config.implementer.fallback).toBeUndefined();

  const cliTools = await detectAvailableCliTools({
    projectDir: target.projectDir,
    tools: ['codex', 'claude-code'],
    authChannels: { codex: 'session', 'claude-code': 'session' },
    role: 'implementer',
  });
  expect(Object.fromEntries(cliTools.map((tool) => [tool.tool, tool.diagnostic.state]))).toEqual({
    codex: 'ready',
    'claude-code': 'ready',
  });
  await rememberDetectedTools(target.projectDir, cliTools);
  const offlinePreload = join(target.tmpDir, 'offline.mjs');
  writeFileSync(
    offlinePreload,
    "globalThis.fetch = async () => { throw new Error('Network disabled in seat switch E2E'); };\n",
  );
  vi.stubEnv('NODE_OPTIONS', `--import=${offlinePreload}`);

  const options = { timeoutMs: 90_000, reapProjectDir: target.projectDir };
  const halted = await cli(target, ['start', 'smoke'], options);
  const sessions = readdirSync(sessionsRoot(target.projectDir));
  expect(sessions).toHaveLength(1);
  const sessionId = sessions[0] ?? '';
  return { target, halted, sessionId, codexCalls, claudeCalls, options };
}

function recordedCalls(callsPath: string): unknown[] {
  return readFileSync(callsPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

describe('e2e: seat down without a fallback, switched by hand', { timeout: 240_000 }, () => {
  it('halts BUILD on an account refusal, then finishes the run on the tool switch-seat names', async () => {
    const { target, halted, sessionId, codexCalls, claudeCalls, options } =
      await codexHaltFixture();
    const ref = { projectDir: target.projectDir, sessionId };
    const haltState = loadState(ref);

    expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);
    expect(halted.stderr).toContain('Seat down (runner-usage-limit)');
    expect(halted.stderr).toContain(
      `Continue with: splitbrief continue ${sessionId} --action switch-seat:claude-code`,
    );
    expect(haltState?.pendingRecovery).toMatchObject({
      reason: 'runner-usage-limit',
      status: 'awaiting-user',
      seat: 'build',
      taskId: 'T001',
      recommendedAction: 'switch-seat',
      switchSeat: {
        seat: 'build',
        candidates: expect.arrayContaining([expect.objectContaining({ tool: 'claude-code' })]),
      },
    });
    expect(haltState?.pendingRecovery?.switchSeat?.auto).toBeUndefined();
    expect(haltState?.pendingRecovery?.availableActions).toContain('switch-seat');
    expect(haltState?.pendingRecovery?.details).toContain('no fallback set');
    expect(haltState?.seatSwitches ?? []).toEqual([]);
    expect(recordedCalls(codexCalls)).toEqual([{ model: PRIMARY_MODEL }]);
    expect(existsSync(claudeCalls)).toBe(false);

    const switched = await cli(
      target,
      ['continue', sessionId, '--action', `switch-seat:claude-code:${SWITCHED_MODEL}`],
      options,
    );
    const state = loadState(ref);
    expect(
      switched.exitCode,
      `${switched.stdout}\n${switched.stderr}\n${JSON.stringify(state?.pendingRecovery, null, 2)}`,
    ).toBe(0);
    expect(switched.stderr).toContain(`BUILD seat recorded in ${CONFIG_RELATIVE_PATH}`);
    expect(switched.stdout).toContain('task T001: done');
    expect(state?.phase).toBe('complete');
    expect(state?.pendingRecovery).toBeUndefined();
    expect(state?.reviewStatus).toBe('passed');
    expect(state?.tasks).toMatchObject([{ id: 'T001', status: 'done' }]);
    expect(state?.seatSwitches).toEqual([
      expect.objectContaining({
        seat: 'build',
        from: 'OpenAI Codex CLI · GPT-5 Codex',
        to: expect.stringContaining('Claude Code CLI'),
        cause: 'runner-usage-limit',
        auto: false,
        configRevision: expect.any(String),
      }),
    ]);
    expect(recordedCalls(codexCalls)).toEqual([{ model: PRIMARY_MODEL }]);
    expect(recordedCalls(claudeCalls)).toEqual([
      { model: SWITCHED_MODEL, prompt: expect.stringContaining(GREET_FILE) },
    ]);
    const implementer = loadConfig(target.projectDir).config.implementer;
    expect(implementer).toMatchObject({
      kind: 'cli',
      tool: 'claude-code',
      model: SWITCHED_MODEL,
    });
    expect(implementer.fallback).toBeUndefined();
    expect(readFileSync(target.greetPath, 'utf8')).toBe(GREET_SOURCE);
  });

  it('refuses a tool the halt did not offer and keeps the halt pending', async () => {
    const { target, halted, sessionId, codexCalls, claudeCalls, options } =
      await codexHaltFixture();
    const ref = { projectDir: target.projectDir, sessionId };
    expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);
    const haltState = loadState(ref);
    expect(haltState?.pendingRecovery?.reason).toBe('runner-usage-limit');

    const refused = await cli(
      target,
      ['continue', sessionId, '--action', 'switch-seat:opencode'],
      options,
    );
    expect(refused.exitCode, `${refused.stdout}\n${refused.stderr}`).toBe(1);
    expect(refused.stderr).toContain(
      "'opencode' is not one of the tools offered for the build seat.",
    );
    const state = loadState(ref);
    expect(state?.pendingRecovery).toEqual(haltState?.pendingRecovery);
    expect(state?.seatSwitches ?? []).toEqual([]);
    expect(loadConfig(target.projectDir).config.implementer).toMatchObject({
      kind: 'cli',
      tool: 'codex',
      model: PRIMARY_MODEL,
    });
    expect(recordedCalls(codexCalls)).toEqual([{ model: PRIMARY_MODEL }]);
    expect(existsSync(claudeCalls)).toBe(false);
  });
});

async function taskRetries(ref: { projectDir: string; sessionId: string }): Promise<string[]> {
  const { events } = await readRunEvents(ref);
  return events.flatMap((event) => (event.type === 'task_retry' ? [event.error] : []));
}

describe('e2e: seat down after the brief wrote its files', { timeout: 240_000 }, () => {
  it('passes the brief on the kept work when the switched seat changes nothing', async () => {
    const { target, halted, sessionId, claudeCalls, options } = await codexHaltFixture(true);
    const ref = { projectDir: target.projectDir, sessionId };
    expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);
    expect(loadState(ref)?.pendingRecovery?.reason).toBe('runner-usage-limit');

    const switched = await cli(
      target,
      ['continue', sessionId, '--action', `switch-seat:claude-code:${SWITCHED_MODEL}`],
      options,
    );
    expect(switched.exitCode, `${switched.stdout}\n${switched.stderr}`).toBe(0);
    expect(switched.stdout).toContain('task T001: done');
    expect(loadState(ref)?.tasks).toMatchObject([{ id: 'T001', status: 'done' }]);
    expect(recordedCalls(claudeCalls)).toHaveLength(1);
    expect(await taskRetries(ref)).toEqual([]);
    expect(readFileSync(target.greetPath, 'utf8')).toBe(GREET_SOURCE);
    expect(readFileSync(target.markerPath, 'utf8')).toBe(MARKER_SOURCE);
  });

  it('passes the brief on the kept work when the switch carries a typed correction', async () => {
    const { target, halted, sessionId, claudeCalls } = await codexHaltFixture(true);
    const ref = { projectDir: target.projectDir, sessionId };
    expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);
    const correction = 'Both files are written. Check them and keep them.';
    vi.stubGlobal('fetch', async () => {
      throw new Error('Network disabled in seat switch E2E');
    });

    const resumed = await continueWithCorrection(target, sessionId, correction, {
      action: `switch-seat:claude-code:${SWITCHED_MODEL}`,
    });
    expect(resumed.tasks).toMatchObject([{ id: 'T001', status: 'done' }]);
    expect(recordedCalls(claudeCalls)).toEqual([
      { model: SWITCHED_MODEL, prompt: expect.stringContaining(correction) },
    ]);
    expect(await taskRetries(ref)).toEqual([]);
    expect(readFileSync(target.greetPath, 'utf8')).toBe(GREET_SOURCE);
    expect(readFileSync(target.markerPath, 'utf8')).toBe(MARKER_SOURCE);
  });
});
