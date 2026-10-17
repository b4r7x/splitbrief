import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { detectAvailableCliTools } from '../../../src/engine/detection/detect.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
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

const ROUTE_MODEL = 'ollama-cloud/deepseek-v4.1-flash';
const NO_ROUTE = `provider.no-route: Model unavailable: ${ROUTE_MODEL}`;
const ROUTE_WARNING = 'BUILD: OpenCode CLI has no credential for ollama-cloud.';
const SIGN_IN_FIX =
  'Run `opencode auth login ollama-cloud`, or choose another model in Settings > Crew > BUILD.';
const SIGNED_OUT =
  'OpenCode CLI has no credential for ollama-cloud. Run `opencode auth login ollama-cloud` in a separate terminal, then retry.';
const WRONG_MODEL = `Model ${ROUTE_MODEL} is not listed by OpenCode CLI; pick a listed model`;
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

/**
 * OpenCode whose Ollama Cloud route refuses every call. Signed in to OpenCode Go only, or, with
 * `credential`, to Ollama Cloud too, so the refusal is the model's and not the account's. Its model
 * list serves OpenCode Go only, as a real OpenCode lists no model of a provider it cannot reach.
 */
function installShims(
  binDir: string,
  opencodeCalls: string,
  claudeCalls: string,
  credential: boolean,
): void {
  const providers = [
    { name: 'OpenCode Go', connections: [{ type: 'credential' }] },
    ...(credential
      ? [{ id: 'ollama-cloud', name: 'Ollama Cloud', connections: [{ type: 'credential' }] }]
      : []),
  ];
  writeFakeNodeCli(
    binDir,
    'opencode',
    `const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('${CLI_TOOL_CATALOG.opencode.compatibility.testedVersion}');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'list') {
  console.log(${JSON.stringify(JSON.stringify(providers))});
  process.exit(0);
}
if (args.join(' ') === 'api GET /api/model') {
  console.log(JSON.stringify({ data: [{ id: 'kimi-k3', providerID: 'opencode-go' }] }));
  process.exit(0);
}
if (args[0] === 'serve') {
  const server = require('node:http').createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.listen(0, '127.0.0.1', () => {
    console.log('server listening on http://127.0.0.1:' + server.address().port);
    console.log('server password route-sidecar-password');
  });
  return;
}
if (args[0] !== 'run') throw new Error('Unexpected opencode invocation: ' + args.join(' '));
appendFileSync(${JSON.stringify(opencodeCalls)}, JSON.stringify({ model: args[args.indexOf('--model') + 1] }) + '\\n');
console.log(JSON.stringify({ type: 'error', error: { type: 'provider.no-route', message: 'Model unavailable: ${ROUTE_MODEL}' } }));
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
const build = () => {
  appendFileSync(${JSON.stringify(claudeCalls)}, JSON.stringify({ model: args.includes('--model') ? args[args.indexOf('--model') + 1] : null }) + '\\n');
  mkdirSync('src', { recursive: true });
  writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
  writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
  emit({ type: 'system', subtype: 'init', session_id: 'route-claude' });
  emit({ type: 'assistant', session_id: 'route-claude', message: { content: [{ type: 'text', text: 'Implemented the greeting helper.' }] } });
  emit({ type: 'result', result: 'Implemented the greeting helper.', session_id: 'route-claude', usage: { input_tokens: 100, output_tokens: 40 } });
};
if (args.includes('--input-format')) {
  const lines = require('node:readline').createInterface({ input: process.stdin });
  lines.once('line', () => {
    build();
    lines.close();
    process.stdin.destroy();
  });
} else {
  readFileSync(0, 'utf8');
  build();
}`,
  );
}

type RouteOptions = {
  seat?: 'build' | 'review';
  credential?: boolean;
  fallback?: { tool: 'claude-code'; model: string };
};

const OPENCODE_ROUTE = { kind: 'cli', tool: 'opencode', model: ROUTE_MODEL } as const;

async function routeFixture({ seat = 'build', credential = false, fallback }: RouteOptions = {}) {
  fixture = createStopContinueFixture(() => '', { isolation: 'none' });
  const target = fixture;
  trustHome = createTrustHome('e2e-route-no-credential-home');
  mkdirSync(join(trustHome.home, '.claude'), { recursive: true });
  writeFileSync(join(trustHome.home, '.claude', '.credentials.json'), '{"fixture":true}\n');
  mkdirSync(join(trustHome.home, '.local', 'share', 'opencode'), { recursive: true });
  writeFileSync(
    join(trustHome.home, '.local', 'share', 'opencode', 'auth.json'),
    '{"opencode-go":{"type":"api"}}\n',
  );
  const binDir = join(target.tmpDir, 'bin');
  mkdirSync(binDir);
  const opencodeCalls = join(target.tmpDir, 'opencode-calls.jsonl');
  const claudeCalls = join(target.tmpDir, 'claude-calls.jsonl');
  installShims(binDir, opencodeCalls, claudeCalls, credential);
  restorePath = activateSafeCliShimPath(binDir);

  const config = loadConfig(target.projectDir).config;
  writeConfig(
    target.projectDir,
    seat === 'build'
      ? {
          ...config,
          implementer: {
            ...OPENCODE_ROUTE,
            contextLength: 200_000,
            ...(fallback !== undefined && { fallback }),
          },
        }
      : {
          ...config,
          implementer: { kind: 'cli', tool: 'claude-code', model: 'sonnet' },
          reviewer: OPENCODE_ROUTE,
        },
  );
  const cliTools = await detectAvailableCliTools({
    projectDir: target.projectDir,
    tools: ['opencode', 'claude-code'],
    authChannels: { opencode: 'provider-dependent', 'claude-code': 'session' },
    role: 'implementer',
  });
  expect(Object.fromEntries(cliTools.map((tool) => [tool.tool, tool.diagnostic.state]))).toEqual({
    opencode: 'ready',
    'claude-code': 'ready',
  });
  await rememberDetectedTools(target.projectDir, cliTools, [
    { tool: 'opencode', models: [{ id: 'opencode-go/kimi-k3' }], probedAt: Date.now() },
  ]);
  const offlinePreload = join(target.tmpDir, 'offline.mjs');
  writeFileSync(
    offlinePreload,
    "globalThis.fetch = async () => { throw new Error('Network disabled in route E2E'); };\n",
  );
  vi.stubEnv('NODE_OPTIONS', `--import=${offlinePreload}`);
  return { target, opencodeCalls, claudeCalls };
}

async function startRun(target: StopContinueFixture) {
  const options = { timeoutMs: 90_000, reapProjectDir: target.projectDir };
  const run = await cli(target, ['start', 'smoke'], options);
  const sessions = readdirSync(sessionsRoot(target.projectDir));
  expect(sessions).toHaveLength(1);
  const ref = { projectDir: target.projectDir, sessionId: sessions[0] ?? '' };
  return { run, ref, state: loadState(ref) };
}

function recordedCalls(callsPath: string): unknown[] {
  return readFileSync(callsPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

async function eventTypes(ref: { projectDir: string; sessionId: string }): Promise<string[]> {
  const { events } = await readRunEvents(ref);
  return events.map((event) => event.type);
}

describe('e2e: a BUILD route with no credential', { timeout: 240_000 }, () => {
  it('warns at start, then halts at once as Seat down with the sign-in step and a seat switch', async () => {
    const { target, opencodeCalls, claudeCalls } = await routeFixture();
    const { run, ref, state } = await startRun(target);
    const output = `${run.stdout}\n${run.stderr}`;

    expect(run.exitCode, output).toBe(1);
    expect(output).toContain(ROUTE_WARNING);
    expect(run.stderr).toContain('Seat down (runner-unauthenticated)');
    expect(output).toContain('`opencode auth login ollama-cloud`');
    expect(state?.pendingRecovery).toMatchObject({
      reason: 'runner-unauthenticated',
      status: 'awaiting-user',
      seat: 'build',
      taskId: 'T001',
      message: SIGNED_OUT,
      facts: { tool: 'OpenCode CLI', provider: 'ollama-cloud' },
      recommendedAction: 'switch-seat',
      switchSeat: {
        seat: 'build',
        candidates: expect.arrayContaining([expect.objectContaining({ tool: 'claude-code' })]),
      },
    });
    expect(state?.pendingRecovery?.details).toContain(`OpenCode CLI reported: ${NO_ROUTE}`);
    expect(recordedCalls(opencodeCalls)).toEqual([{ model: ROUTE_MODEL }]);
    const types = await eventTypes(ref);
    expect(types).not.toContain('task_retry');
    expect(types).not.toContain('task_escalating');
    expect(() => readFileSync(claudeCalls)).toThrow();
  });

  it('moves BUILD to its declared fallback and completes the run', async () => {
    const { target, opencodeCalls, claudeCalls } = await routeFixture({
      fallback: { tool: 'claude-code', model: 'sonnet' },
    });
    const { run, ref, state } = await startRun(target);

    expect(
      run.exitCode,
      `${run.stdout}\n${run.stderr}\n${JSON.stringify(state?.pendingRecovery, null, 2)}`,
    ).toBe(0);
    expect(run.stdout).toContain('task T001: done');
    expect(state?.phase).toBe('complete');
    expect(state?.seatSwitches).toEqual([
      expect.objectContaining({
        seat: 'build',
        to: expect.stringContaining('Claude Code CLI'),
        cause: 'runner-unauthenticated',
        auto: true,
      }),
    ]);
    expect(recordedCalls(opencodeCalls)).toEqual([{ model: ROUTE_MODEL }]);
    expect(recordedCalls(claudeCalls)).toEqual([{ model: 'sonnet' }]);
    const types = await eventTypes(ref);
    expect(types).not.toContain('task_retry');
    expect(types).not.toContain('task_escalating');
    expect(readFileSync(target.greetPath, 'utf8')).toBe(GREET_SOURCE);
  });

  it('halts a refused model on a route with a credential as a model to change, never moving to the fallback', async () => {
    const { target, opencodeCalls, claudeCalls } = await routeFixture({
      credential: true,
      fallback: { tool: 'claude-code', model: 'sonnet' },
    });
    const { run, ref, state } = await startRun(target);
    const output = `${run.stdout}\n${run.stderr}`;

    expect(run.exitCode, output).toBe(1);
    expect(output).not.toContain(ROUTE_WARNING);
    expect(state?.pendingRecovery).toMatchObject({
      reason: 'implementer-recipe-invalid',
      status: 'awaiting-user',
      seat: 'build',
      taskId: 'T001',
      message: WRONG_MODEL,
      facts: { refusal: 'wrong-model' },
      recommendedAction: 'switch-seat',
      switchSeat: { seat: 'build', candidates: expect.any(Array) },
    });
    expect(state?.pendingRecovery?.switchSeat?.auto).toBeUndefined();
    expect(state?.seatSwitches ?? []).toEqual([]);
    expect(recordedCalls(opencodeCalls)).toEqual([{ model: ROUTE_MODEL }]);
    const types = await eventTypes(ref);
    expect(types).not.toContain('task_retry');
    expect(types).not.toContain('task_escalating');
    expect(() => readFileSync(claudeCalls)).toThrow();
  });

  it('doctor reports the route as not signed in, once, with its sign-in step', async () => {
    const { target } = await routeFixture();

    const human = await cli(target, ['doctor'], { timeoutMs: 60_000 });
    const out = stripVTControlCharacters(human.stdout);
    expect(out, human.stderr).toContain(`warning  ${ROUTE_WARNING}`);
    expect(out).toContain(`Fix: ${SIGN_IN_FIX}`);
    expect(out.split(ROUTE_WARNING)).toHaveLength(2);

    const json = await cli(target, ['doctor'], { timeoutMs: 60_000, json: true });
    const record = JSON.parse(json.stdout.trim()) as {
      report: { checks: { id: string; summary: string; remediation?: string }[] };
    };
    const routeChecks = record.report.checks.filter((check) => check.summary === ROUTE_WARNING);
    expect(routeChecks).toEqual([
      expect.objectContaining({ id: 'runners.route.implementer.default' }),
    ]);
  });
});

describe('e2e: a REVIEW route refused by OpenCode', { timeout: 240_000 }, () => {
  it('halts the review as Seat down with the sign-in step when the route has no credential', async () => {
    const { target, opencodeCalls, claudeCalls } = await routeFixture({ seat: 'review' });
    const { run, state } = await startRun(target);
    const output = `${run.stdout}\n${run.stderr}`;

    expect(run.exitCode, output).toBe(1);
    expect(output).toContain('task T001: done');
    expect(state?.pendingRecovery).toMatchObject({
      reason: 'runner-unauthenticated',
      status: 'awaiting-user',
      seat: 'review',
      message: SIGNED_OUT,
      facts: { tool: 'OpenCode CLI', provider: 'ollama-cloud' },
      recommendedAction: 'switch-seat',
      switchSeat: {
        seat: 'review',
        candidates: expect.arrayContaining([expect.objectContaining({ tool: 'claude-code' })]),
      },
    });
    expect(recordedCalls(opencodeCalls)).toEqual([{ model: ROUTE_MODEL }]);
    expect(recordedCalls(claudeCalls)).toEqual([{ model: 'sonnet' }]);
  });

  it('halts the review on a refused model as a model to change when the route has a credential', async () => {
    const { target, opencodeCalls } = await routeFixture({ seat: 'review', credential: true });
    const { run, state } = await startRun(target);
    const output = `${run.stdout}\n${run.stderr}`;

    expect(run.exitCode, output).toBe(1);
    expect(output).not.toContain('REVIEW: OpenCode CLI has no credential');
    expect(state?.pendingRecovery).toMatchObject({
      reason: 'planner-call-failed',
      status: 'awaiting-user',
      seat: 'review',
      message: WRONG_MODEL,
      facts: { refusal: 'wrong-model' },
      recommendedAction: 'switch-seat',
      switchSeat: { seat: 'review', candidates: expect.any(Array) },
    });
    expect(state?.pendingRecovery?.details).toContain(
      'The run stopped instead of spending retries on a model the tool refuses.',
    );
    expect(recordedCalls(opencodeCalls)).toEqual([{ model: ROUTE_MODEL }]);
  });
});
