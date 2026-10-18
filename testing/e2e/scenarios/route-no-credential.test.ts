import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { routeAuthState } from '../../../src/core/runners/route-auth.js';
import { detectAvailableCliTools } from '../../../src/engine/detection/detect.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { formatRouteAuth } from '../../../src/features/runners/picker-format.js';
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
const LOCAL_MODEL = 'ollama/llama3';
const PROJECT_MODEL = 'lmstudio/qwen3';
const GATEWAY_MODEL = 'opencode/grok-code';
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
 * A `localOnly` OpenCode stores no credential at all and serves the Ollama set up in its config,
 * and the LM Studio set up in the project's config only when the listing names that project.
 * A `databaseSignIn` OpenCode stores no `auth.json` credential. Like OpenCode 2, its listing names
 * the OpenCode gateway sign-in only when it can read `$XDG_DATA_HOME/opencode/opencode.db`.
 */
function installShims(
  binDir: string,
  opencodeCalls: string,
  claudeCalls: string,
  credential: boolean,
  localOnly: boolean,
  databaseSignIn: boolean,
  projectDir: string,
): void {
  const providers =
    localOnly || databaseSignIn
      ? []
      : [
          { name: 'OpenCode Go', connections: [{ type: 'credential' }] },
          ...(credential
            ? [{ id: 'ollama-cloud', name: 'Ollama Cloud', connections: [{ type: 'credential' }] }]
            : []),
        ];
  const gateway = { id: 'opencode', name: 'OpenCode', connections: [{ type: 'credential' }] };
  const served = localOnly
    ? { id: 'llama3', providerID: 'ollama' }
    : databaseSignIn
      ? { id: 'grok-code', providerID: 'opencode' }
      : { id: 'kimi-k3', providerID: 'opencode-go' };
  const projectServed = localOnly ? [{ id: 'qwen3', providerID: 'lmstudio' }] : [];
  writeFakeNodeCli(
    binDir,
    'opencode',
    `const { appendFileSync, existsSync, realpathSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('${CLI_TOOL_CATALOG.opencode.compatibility.testedVersion}');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'list') {
  const data = process.env.XDG_DATA_HOME || join(require('node:os').homedir(), '.local', 'share');
  const database = existsSync(join(data, 'opencode', 'opencode.db'));
  console.log(JSON.stringify([...${JSON.stringify(providers)}, ...(database ? [${JSON.stringify(gateway)}] : [])]));
  process.exit(0);
}
if (args.slice(0, 3).join(' ') === 'api GET /api/model') {
  const header = args[3] === '-H' ? args[4] : '';
  const directory = header.startsWith('x-opencode-directory:') ? header.slice(21) : '';
  const named =
    directory !== '' &&
    !directory.includes('/') &&
    realpathSync(decodeURIComponent(directory)) === realpathSync(${JSON.stringify(projectDir)});
  console.log(JSON.stringify({ data: [${JSON.stringify(served)}, ...(named ? ${JSON.stringify(projectServed)} : [])] }));
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
  localOnly?: boolean;
  /** Signed in with `opencode auth login` only: OpenCode 2 keeps it in `opencode.db`, never in `auth.json`. */
  databaseSignIn?: boolean;
  /** The local-only seat takes the provider set up in the project's OpenCode config. */
  projectModel?: boolean;
  /**
   * Whether the project holds a saved OpenCode model list; without one, doctor and start read it
   * fresh. `before-crew` saves the list a pass read before OpenCode joined the crew, which names
   * no project, as an earlier release saved every list.
   */
  savedList?: boolean | 'before-crew';
  fallback?: { tool: 'claude-code'; model: string };
};

async function routeFixture({
  seat = 'build',
  credential = false,
  localOnly = false,
  databaseSignIn = false,
  projectModel = false,
  savedList = true,
  fallback,
}: RouteOptions = {}) {
  const opencodeRoute = {
    kind: 'cli',
    tool: 'opencode',
    model: databaseSignIn
      ? GATEWAY_MODEL
      : projectModel
        ? PROJECT_MODEL
        : localOnly
          ? LOCAL_MODEL
          : ROUTE_MODEL,
  } as const;
  fixture = createStopContinueFixture(() => '', { isolation: 'none' });
  const target = fixture;
  trustHome = createTrustHome('e2e-route-no-credential-home');
  // OpenCode reads its own config, so it reads the one under this home, never the tester's.
  vi.stubEnv('XDG_CONFIG_HOME', join(trustHome.home, '.config'));
  vi.stubEnv('XDG_DATA_HOME', join(trustHome.home, '.local', 'share'));
  mkdirSync(join(trustHome.home, '.claude'), { recursive: true });
  writeFileSync(join(trustHome.home, '.claude', '.credentials.json'), '{"fixture":true}\n');
  const opencodeData = join(trustHome.home, '.local', 'share', 'opencode');
  if (databaseSignIn) {
    mkdirSync(opencodeData, { recursive: true });
    writeFileSync(join(opencodeData, 'opencode.db'), 'fixture');
  } else if (!localOnly) {
    mkdirSync(opencodeData, { recursive: true });
    writeFileSync(join(opencodeData, 'auth.json'), '{"opencode-go":{"type":"api"}}\n');
  }
  const binDir = join(target.tmpDir, 'bin');
  mkdirSync(binDir);
  const opencodeCalls = join(target.tmpDir, 'opencode-calls.jsonl');
  const claudeCalls = join(target.tmpDir, 'claude-calls.jsonl');
  installShims(
    binDir,
    opencodeCalls,
    claudeCalls,
    credential,
    localOnly,
    databaseSignIn,
    target.projectDir,
  );
  restorePath = activateSafeCliShimPath(binDir);

  const config = loadConfig(target.projectDir).config;
  writeConfig(
    target.projectDir,
    seat === 'build'
      ? {
          ...config,
          implementer: {
            ...opencodeRoute,
            contextLength: 200_000,
            ...(fallback !== undefined && { fallback }),
          },
        }
      : {
          ...config,
          implementer: { kind: 'cli', tool: 'claude-code', model: 'sonnet' },
          reviewer: opencodeRoute,
        },
  );
  const cliTools = await detectAvailableCliTools({
    projectDir: target.projectDir,
    tools: ['opencode', 'claude-code'],
    authChannels: { opencode: 'provider-dependent', 'claude-code': 'session' },
    role: 'implementer',
  });
  expect(Object.fromEntries(cliTools.map((tool) => [tool.tool, tool.diagnostic.state]))).toEqual({
    opencode: localOnly ? 'unauthenticated' : 'ready',
    'claude-code': 'ready',
  });
  await rememberDetectedTools(
    target.projectDir,
    cliTools,
    savedList === false
      ? []
      : [
          {
            tool: 'opencode',
            models: [{ id: localOnly ? LOCAL_MODEL : 'opencode-go/kimi-k3' }],
            ...(savedList === 'before-crew' ? {} : { namesProject: true }),
            probedAt: Date.now(),
          },
        ],
  );
  const offlinePreload = join(target.tmpDir, 'offline.mjs');
  writeFileSync(
    offlinePreload,
    "globalThis.fetch = async () => { throw new Error('Network disabled in route E2E'); };\n",
  );
  vi.stubEnv('NODE_OPTIONS', `--import=${offlinePreload}`);
  return { target, opencodeCalls, claudeCalls, cliTools };
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

describe('e2e: a local-only OpenCode that stores no credential', { timeout: 240_000 }, () => {
  it.each([
    { label: 'saved', savedList: true, projectModel: false },
    { label: 'read fresh', savedList: false, projectModel: false },
    { label: 'project-naming', savedList: false, projectModel: true },
    { label: 'saved-before-crew', savedList: 'before-crew' as const, projectModel: true },
  ])(
    'doctor shows no blocker for a BUILD route its $label model list serves, and claims no sign-in',
    async ({ savedList, projectModel }) => {
      const { target } = await routeFixture({ localOnly: true, savedList, projectModel });

      const json = await cli(target, ['doctor'], { timeoutMs: 60_000, json: true });
      const record = JSON.parse(json.stdout.trim()) as {
        report: { checks: { id: string; severity: string; summary: string }[] };
      };
      const runnerChecks = record.report.checks.filter((check) => check.id.startsWith('runners.'));
      // The fixture's PLAN is a repository-local command, which doctor refuses on its own.
      const buildBlockers = runnerChecks.filter(
        (check) => check.severity === 'blocker' && /opencode|implementer/.test(check.id),
      );
      expect(buildBlockers, json.stderr).toEqual([]);
      expect(runnerChecks.find((check) => check.id === 'runners.cli.opencode.readiness')).toEqual(
        expect.objectContaining({
          severity: 'ok',
          summary: expect.stringContaining('stores no credential'),
        }),
      );
      expect(runnerChecks.map((check) => check.summary).join('\n')).not.toMatch(
        /OpenCode CLI (is not signed in|has no credential|is installed, trusted, compatible, and signed in)/,
      );
    },
  );

  it.each([
    { label: 'saved', savedList: true, projectModel: false },
    { label: 'read fresh', savedList: false, projectModel: false },
    { label: 'project-naming', savedList: false, projectModel: true },
    { label: 'saved-before-crew', savedList: 'before-crew' as const, projectModel: true },
  ])(
    'start admits the BUILD seat by its $label model list and calls OpenCode on that route',
    async ({ savedList, projectModel }) => {
      const { target, opencodeCalls } = await routeFixture({
        localOnly: true,
        savedList,
        projectModel,
      });
      const { run } = await startRun(target);
      const output = `${run.stdout}\n${run.stderr}`;

      expect(output).not.toContain('OpenCode CLI is not signed in.');
      expect(recordedCalls(opencodeCalls)).toEqual([
        { model: projectModel ? PROJECT_MODEL : LOCAL_MODEL },
      ]);
    },
  );
});

describe('e2e: OpenCode signed in with opencode auth login', { timeout: 240_000 }, () => {
  it('reads the OpenCode gateway route as signed in from opencode.db alone, and start calls it', async () => {
    const { target, opencodeCalls, cliTools } = await routeFixture({
      databaseSignIn: true,
      savedList: false,
    });
    const providerAuth = cliTools.find((tool) => tool.tool === 'opencode')?.providerAuth;
    const route = routeAuthState({
      tool: 'opencode',
      model: GATEWAY_MODEL,
      providerAuth,
      catalog: undefined,
    });
    expect(formatRouteAuth({ auth: route }).word).toBe('signed in · stored credential');

    const doctor = await cli(target, ['doctor'], { timeoutMs: 60_000 });
    const out = stripVTControlCharacters(doctor.stdout);
    expect(out, doctor.stderr).toContain(
      'OpenCode CLI is installed, trusted, compatible, and signed in.',
    );
    expect(out).not.toContain('OpenCode CLI has no credential for opencode');

    const { run } = await startRun(target);
    expect(`${run.stdout}\n${run.stderr}`).not.toContain('OpenCode CLI is not signed in.');
    expect(recordedCalls(opencodeCalls)).toEqual([{ model: GATEWAY_MODEL }]);
  });
});
