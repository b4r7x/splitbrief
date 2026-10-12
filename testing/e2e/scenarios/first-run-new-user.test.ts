import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { configPath } from '../../../src/core/config/load/document.js';
import { loadConfig } from '../../../src/core/config/load/io.js';
import { CONFIG_FILE, SPLITBRIEF_DIR, sessionsRoot } from '../../../src/core/paths.js';
import { deriveRunStatus } from '../../../src/core/sessions/run-status.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome as createTrustHome } from '#testing/helpers/trust-home.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import { spawnCli } from '../helpers/live-cli-harness.js';
import { assertPlainStdout } from '../helpers/run-dir-assertions.js';
import { GREET_FILE, GREET_SOURCE } from '../helpers/stop-continue-fixture.js';

/** The implementer `init --yes` writes: `createDefaultConfig` in src/core/config/load/defaults.ts. */
const OLLAMA_MODEL = 'qwen3-coder:30b';
const OLLAMA_BASE = 'http://localhost:11434/v1';
const OLLAMA_ORIGIN_PORT = '11434';
const OLLAMA_CONTEXT = 131_072;
const OLLAMA_MAXIMUM_CONTEXT = 262_144;
const FEATURE = 'Add a greeting helper';
const CHECKS_PROMPT = '# Choose the checks for this review';
const REVIEW_PROMPT = 'Final Implementation Review';
const CLI_TIMEOUT_MS = 60_000;
const START_TIMEOUT_MS = 150_000;

const PLAN_ANSWER = {
  result: makePlanProposal({
    summary: 'Add a standalone greeting helper.',
    decisions: [],
    tasks: [
      makeTaskSpec({
        title: 'Add a greeting helper',
        intent: `Export greet from ${GREET_FILE}.`,
        suggestedFiles: [GREET_FILE],
        checks: [{ id: 'K1', kind: 'cmd', value: 'node --version', required: true }],
        steps: [`Create \`${GREET_FILE}\` exporting \`greet\`.`],
      }),
    ],
  }),
};

const CHECKS_ANSWER = {
  commands: [{ id: 'V1', command: 'node --version', reason: 'The runtime the helper needs.' }],
  declined: [],
  reason: null,
};

const REVIEW_ANSWER = passingVerdict({ kind: 'final', taskIds: ['T001'], criterionIds: ['C1'] });

const BUILD_REPLY = JSON.stringify({
  version: 1,
  files: [{ path: GREET_FILE, action: 'create', content: GREET_SOURCE }],
});

const ClaudeCallSchema = z.object({
  seat: z.enum(['plan', 'checks', 'review', 'other']),
  args: z.array(z.string()),
});

const ChatRequestSchema = z.object({
  model: z.string(),
  messages: z.array(z.object({ role: z.string() })),
});

const DoctorRecordSchema = z.object({
  type: z.literal('readiness_report'),
  report: z.object({
    status: z.enum(['ready', 'ready-with-warnings', 'blocked']),
    checks: z.array(
      z.object({
        id: z.string(),
        severity: z.enum(['ok', 'info', 'warning', 'blocker']),
        summary: z.string(),
        stateId: z.string().nullable(),
        remediation: z.string().nullable(),
      }),
    ),
  }),
});

type OllamaRequest = Readonly<{ method: string; path: string; body: unknown }>;

type OllamaFake = Readonly<{
  port: number;
  requests: OllamaRequest[];
  close: () => Promise<void>;
}>;

type FirstRun = Readonly<{
  home: string;
  tmpDir: string;
  projectDir: string;
  stateHome: string;
  bin: string;
  callsPath: string;
  ollama: OllamaFake;
}>;

let tmpDir: string | undefined;
let ollama: OllamaFake | undefined;
let restorePath: (() => void) | undefined;
let trustHome: ReturnType<typeof createTrustHome> | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  restorePath?.();
  trustHome?.restore();
  await ollama?.close();
  if (tmpDir !== undefined) cleanupTempDir(tmpDir);
  tmpDir = undefined;
  ollama = undefined;
  restorePath = undefined;
  trustHome = undefined;
});

function sendJson(response: ServerResponse, body: unknown): void {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(body));
}

function sendCompletion(response: ServerResponse, text: string): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const frame = { id: 'first-run-build', object: 'chat.completion.chunk', created: 1 };
  const model = OLLAMA_MODEL;
  response.write(
    `data: ${JSON.stringify({ ...frame, model, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({ ...frame, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } })}\n\n`,
  );
  response.end('data: [DONE]\n\n');
}

/** Answers the Ollama routes the default implementer reads: `src/engine/providers/ollama.ts`. */
async function serveOllama(
  request: IncomingMessage,
  response: ServerResponse,
  requests: OllamaRequest[],
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  const method = request.method ?? '';
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  requests.push({ method, path, body: text === '' ? undefined : JSON.parse(text) });
  switch (`${method} ${path}`) {
    case 'GET /api/tags':
      sendJson(response, { models: [{ name: OLLAMA_MODEL }] });
      return;
    case 'GET /api/ps':
      sendJson(response, {
        models: [{ name: OLLAMA_MODEL, model: OLLAMA_MODEL, context_length: OLLAMA_CONTEXT }],
      });
      return;
    case 'POST /api/show':
      sendJson(response, {
        model_info: {
          'general.architecture': 'qwen3moe',
          'qwen3moe.context_length': OLLAMA_MAXIMUM_CONTEXT,
        },
        parameters: `num_ctx ${OLLAMA_CONTEXT}`,
      });
      return;
    case 'GET /v1/models':
      sendJson(response, {
        object: 'list',
        data: [{ id: OLLAMA_MODEL, object: 'model', owned_by: 'library' }],
      });
      return;
    case 'POST /v1/chat/completions':
      sendCompletion(response, BUILD_REPLY);
      return;
    default:
      response.statusCode = 404;
      response.end();
  }
}

async function startOllama(): Promise<OllamaFake> {
  const requests: OllamaRequest[] = [];
  const server = createServer((request, response) => {
    void serveOllama(request, response, requests).catch((cause: unknown) => {
      response.statusCode = 500;
      response.end(String(cause));
    });
  });
  await new Promise<void>((resolveListening, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListening);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The Ollama fake has no TCP address');
  }
  return {
    port: address.port,
    requests,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

/**
 * Every node process of the run loads this first. The default implementer's endpoint,
 * `localhost:11434`, reaches the fake on its own port; every other request fails.
 */
function writeNetworkPreload(dir: string, port: number): string {
  const preload = join(dir, 'offline.mjs');
  writeFileSync(
    preload,
    `const nativeFetch = globalThis.fetch;
const fake = 'http://127.0.0.1:${port}';
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if ((url.hostname === 'localhost' || url.hostname === '127.0.0.1') && url.port === '${OLLAMA_ORIGIN_PORT}') {
    const local = new URL(url.pathname + url.search, fake);
    if (!(input instanceof Request)) return nativeFetch(local, init);
    const body = input.body === null ? {} : { body: input.body, duplex: 'half' };
    return nativeFetch(new Request(local, { method: input.method, headers: input.headers, signal: input.signal, ...body }), init);
  }
  throw new Error('Network disabled in first-run E2E: ' + url.origin);
};
`,
  );
  return preload;
}

/**
 * A Claude Code CLI that answers the readiness probes and speaks the stream-json protocol
 * for the three typed calls of the run: the plan, the reviewer checks and the final review.
 */
function installClaudeShim(bin: string, callsPath: string): void {
  writeFakeNodeCli(
    bin,
    'claude',
    `const fs = require('node:fs');
const readline = require('node:readline');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('claude 2.1.296'); process.exit(0); }
if (args.includes('--help')) { console.log('Claude Code fixture'); process.exit(0); }
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const answers = ${JSON.stringify({ plan: PLAN_ANSWER, checks: CHECKS_ANSWER, review: REVIEW_ANSWER })};
const emit = (entry) => console.log(JSON.stringify(entry));
const promptText = (content) => typeof content === 'string'
  ? content
  : content.filter((part) => part.type === 'text').map((part) => part.text).join('\\n');
const answer = (text) => {
  const seat = text.includes(${JSON.stringify(CHECKS_PROMPT)})
    ? 'checks'
    : text.includes(${JSON.stringify(REVIEW_PROMPT)})
      ? 'review'
      : args.includes('--json-schema') ? 'plan' : 'other';
  fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ seat, args }) + '\\n');
  emit({ type: 'system', subtype: 'init', session_id: 'first-run-session' });
  if (args.includes('--input-format')) emit({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: text } });
  const value = seat === 'other' ? 'Done.' : answers[seat];
  emit({
    type: 'result',
    session_id: 'first-run-session',
    result: typeof value === 'string' ? value : JSON.stringify(value),
    ...(typeof value === 'string' ? {} : { structured_output: value }),
    usage: { input_tokens: 10, output_tokens: 5 },
  });
};
if (args.includes('--input-format')) {
  const lines = readline.createInterface({ input: process.stdin });
  lines.once('line', (line) => {
    answer(promptText(JSON.parse(line).message.content));
    lines.close();
    process.stdin.destroy();
  });
} else {
  answer(fs.readFileSync(0, 'utf8'));
}`,
  );
}

/** A fresh HOME, a fresh repository with no config, and the default implementer's endpoint. */
async function firstRunFixture(prefix: string): Promise<FirstRun> {
  trustHome = createTrustHome(`${prefix}-home`);
  const home = trustHome.home;
  vi.stubEnv('XDG_CONFIG_HOME', join(home, 'xdg-config'));
  vi.stubEnv('XDG_CACHE_HOME', join(home, 'xdg-cache'));
  vi.stubEnv('XDG_DATA_HOME', join(home, 'xdg-data'));
  tmpDir = createTempDir(prefix);
  const projectDir = join(tmpDir, 'project');
  mkdirSync(projectDir, { recursive: true });
  createTestGitRepo(projectDir, { 'README.md': '# Greeter\n' });
  const stateHome = join(tmpDir, 'state');
  mkdirSync(stateHome, { recursive: true });
  const bin = join(tmpDir, 'bin');
  mkdirSync(bin);
  ollama = await startOllama();
  vi.stubEnv('NODE_OPTIONS', `--import=${writeNetworkPreload(tmpDir, ollama.port)}`);
  return {
    home,
    tmpDir,
    projectDir,
    stateHome,
    bin,
    callsPath: join(tmpDir, 'claude-calls.jsonl'),
    ollama,
  };
}

function splitbrief(target: FirstRun, args: readonly string[], timeoutMs = CLI_TIMEOUT_MS) {
  return spawnCli({
    args: ['--import', 'tsx', 'src/cli.ts', ...args, '--project', target.projectDir],
    stateHome: target.stateHome,
    timeoutMs,
    reapProjectDir: target.projectDir,
  });
}

async function initProject(target: FirstRun): Promise<Buffer> {
  expect(existsSync(configPath(target.projectDir))).toBe(false);
  const init = await splitbrief(target, ['init', '--yes']);
  expect(init.exitCode, `${init.stdout}\n${init.stderr}`).toBe(0);
  expect(init.stdout).toContain(`Wrote ${SPLITBRIEF_DIR}/${CONFIG_FILE}`);
  return readFileSync(configPath(target.projectDir));
}

async function doctorJson(target: FirstRun) {
  const run = await splitbrief(target, ['doctor', '--json']);
  const record = run.stdout.trim().split('\n').at(-1) ?? '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(record);
  } catch (cause) {
    throw new Error(`doctor --json emitted no record\n${run.stdout}\n${run.stderr}`, { cause });
  }
  const report = DoctorRecordSchema.parse(parsed).report;
  return { run, report, check: (id: string) => report.checks.find((check) => check.id === id) };
}

function claudeSeats(callsPath: string): string[] {
  return readFileSync(callsPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => ClaudeCallSchema.parse(JSON.parse(line)).seat)
    .filter((seat) => seat !== 'other');
}

describe('e2e: first run of a new user', { timeout: 240_000 }, () => {
  it('runs init, doctor, start and Apply on the default crew without a config edit', async () => {
    const target = await firstRunFixture('e2e-first-run');
    mkdirSync(join(target.home, '.claude'), { recursive: true });
    writeFileSync(join(target.home, '.claude', '.credentials.json'), '{"fixture":true}\n');
    installClaudeShim(target.bin, target.callsPath);
    restorePath = activateSafeCliShimPath(target.bin);

    const configBytes = await initProject(target);
    const config = loadConfig(target.projectDir).config;
    expect(config.planner).toMatchObject({ kind: 'cli', tool: 'claude-code' });
    expect(config.implementer).toMatchObject({
      kind: 'api',
      provider: 'ollama',
      model: OLLAMA_MODEL,
      apiBase: OLLAMA_BASE,
    });
    expect(config.reviewer).toBeUndefined();
    expect(config.workflow.approve).toBe('plan');

    const doctor = await doctorJson(target);
    expect(doctor.run.exitCode, `${doctor.run.stdout}\n${doctor.run.stderr}`).toBe(0);
    expect(doctor.report.status).not.toBe('blocked');
    expect(doctor.check('runners.cli.claude-code.readiness')?.severity).toBe('ok');
    expect(doctor.check('runners.availability.implementer.default')?.severity).toBe('ok');

    const run = await splitbrief(target, ['start', FEATURE, '--plain'], START_TIMEOUT_MS);
    const output = `${run.stdout}\n${run.stderr}\n${JSON.stringify(target.ollama.requests)}`;
    expect(run.exitCode, output).toBe(0);
    expect(assertPlainStdout(run.stdout)).toBe(1);
    expect(run.stdout.split('\n').map((line) => line.trim())).toContain('done: 1 tasks');

    const sessions = readdirSync(sessionsRoot(target.projectDir));
    expect(sessions).toHaveLength(1);
    const sessionId = sessions[0] ?? '';
    const ref = { projectDir: target.projectDir, sessionId };
    const finished = loadState(ref);
    if (finished === null) throw new Error(`the run left no state: ${output}`);
    expect(finished.tasks).toMatchObject([{ id: 'T001', status: 'done' }]);
    expect(finished.pendingRecovery).toBeUndefined();
    expect(deriveRunStatus({ state: finished, liveness: 'not-alive' })).toEqual({
      kind: 'ready-to-apply',
      override: false,
    });
    expect(existsSync(join(target.projectDir, GREET_FILE))).toBe(false);

    expect(claudeSeats(target.callsPath)).toEqual(['plan', 'checks', 'review']);
    const builds = target.ollama.requests
      .filter((request) => request.method === 'POST' && request.path === '/v1/chat/completions')
      .map((request) => ChatRequestSchema.parse(request.body));
    expect(builds).toHaveLength(1);
    expect(builds[0]?.model).toBe(OLLAMA_MODEL);

    const applied = await splitbrief(target, [
      'continue',
      sessionId,
      '--action',
      'apply',
      '--plain',
    ]);
    expect(applied.exitCode, `${applied.stdout}\n${applied.stderr}`).toBe(0);
    expect(applied.stderr).toContain('Applied 1 file to your checkout.');
    expect(loadState(ref)?.closed?.as).toBe('applied');
    expect(readFileSync(join(target.projectDir, GREET_FILE), 'utf8')).toBe(GREET_SOURCE);

    expect(readFileSync(configPath(target.projectDir))).toEqual(configBytes);
  });

  it('has doctor name the missing planner tool as a blocker', async () => {
    const target = await firstRunFixture('e2e-first-run-missing');
    vi.stubEnv('PATH', [target.bin, '/usr/bin', '/bin'].join(delimiter));

    await initProject(target);

    const doctor = await doctorJson(target);
    expect(doctor.run.exitCode, `${doctor.run.stdout}\n${doctor.run.stderr}`).toBe(1);
    expect(doctor.report.status).toBe('blocked');
    expect(doctor.check('runners.cli.claude-code.readiness')).toMatchObject({
      severity: 'blocker',
      summary: 'Claude Code CLI readiness is unavailable.',
      stateId: 'missing-binary',
      remediation: 'Install claude-code, then run runner readiness again.',
    });
    expect(doctor.check('runners.planner.configured')?.summary).toContain('Planner claude-code');
    expect(doctor.check('runners.availability.implementer.default')?.severity).toBe('ok');

    const human = await splitbrief(target, ['doctor']);
    expect(human.exitCode, `${human.stdout}\n${human.stderr}`).toBe(1);
    expect(human.stdout).toContain('Run readiness: blocked');
    expect(human.stdout).toContain(
      'blocker runners.cli.claude-code.readiness: Claude Code CLI readiness is unavailable.',
    );
    expect(human.stdout).toContain('Fix: Install claude-code, then run runner readiness again.');
    expect(human.stdout).toContain('Planner claude-code');
    expect(existsSync(sessionsRoot(target.projectDir))).toBe(false);
  });
});
