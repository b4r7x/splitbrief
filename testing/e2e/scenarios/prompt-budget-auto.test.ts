import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import {
  reviewPacketJsonPath,
  reviewPacketMarkdownPath,
  SESSION_LOG_FILE,
  STATE_FILE,
  sessionDir,
  sessionsRoot,
} from '../../../src/core/paths.js';
import { ReviewPacketSchema } from '../../../src/core/schemas/review/packet.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { makeOpenAiSseResponse } from '#testing/helpers/faux/openai-sse.js';
import type { renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import { openHaltedRun, settleOpenedRuns } from '../helpers/halted-run-screen.js';
import {
  cli,
  createStopContinueFixture,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';
import { transcriptText } from '../helpers/transcript-text.js';

const BIG_FILE = 'src/big.ts';
const BIG_SOURCE = 'export const v = 1;\n'.repeat(1500);
const TIGHT_SOURCE = 'export const v = 1;\n'.repeat(585);
const DONE_LINE = 'export const DONE = true;\n';
const MODEL = 'fixture/build-model';
const FIT_ERROR = 'Task T001 does not fit the BUILD model’s context';
const RequestSchema = z.object({
  model: z.string(),
  messages: z.array(z.object({ role: z.string(), content: z.string() })),
});

let fixture: StopContinueFixture | undefined;
let home: ReturnType<typeof useTrustHome> | undefined;
let server: Server | undefined;
let serverFailure: unknown;
let ui: ReturnType<typeof renderFeature> | undefined;

beforeEach(() => {
  resetAllStores();
  home = useTrustHome('e2e-prompt-budget-home');
});

afterEach(async () => {
  ui?.unmount();
  ui = undefined;
  await settleOpenedRuns();
  resetAllStores();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  const open = server;
  if (open !== undefined) {
    open.closeAllConnections();
    await new Promise<void>((done) => open.close(() => done()));
  }
  server = undefined;
  serverFailure = undefined;
  home?.restore();
  home = undefined;
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

/**
 * An OpenAI-compatible endpoint on loopback that lists MODEL and answers each BUILD call with one
 * bundle that rewrites `source`. With `refuse`, it records each BUILD call and refuses its prompt
 * as too long.
 */
async function startEndpoint(
  refuse: boolean,
  source: string,
): Promise<{
  apiBase: string;
  completions: z.infer<typeof RequestSchema>[];
}> {
  const completions: z.infer<typeof RequestSchema>[] = [];
  const endpoint = createServer((request, response) => {
    const serve = async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({
            object: 'list',
            data: [{ id: MODEL, object: 'model', owned_by: 'fixture' }],
          }),
        );
        return;
      }
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.statusCode = 404;
        response.end();
        return;
      }
      completions.push(RequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      if (refuse) {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            error: {
              message:
                "This model's maximum context length is 8192 tokens. However, your messages resulted in 9100 tokens.",
              type: 'invalid_request_error',
              code: 'context_length_exceeded',
            },
          }),
        );
        return;
      }
      const bundle = {
        version: 1,
        files: [{ path: BIG_FILE, action: 'modify', content: source + DONE_LINE }],
      };
      const reply = makeOpenAiSseResponse([{ content: JSON.stringify(bundle) }, {}]);
      response.writeHead(reply.status, { 'Content-Type': 'text/event-stream' });
      response.end(await reply.text());
    };
    void serve().catch((cause: unknown) => {
      serverFailure = cause;
      response.statusCode = 500;
      response.end(String(cause));
    });
  });
  server = endpoint;
  await new Promise<void>((resolveListening, reject) => {
    endpoint.once('error', reject);
    endpoint.listen(0, '127.0.0.1', resolveListening);
  });
  const address = endpoint.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The fixture endpoint has no TCP address');
  }
  return { apiBase: `http://127.0.0.1:${address.port}/v1`, completions };
}

/**
 * A project with one module of `source`, a shell planner that plans one brief on it, and an API
 * BUILD seat on the fixture endpoint. `contextLength` is the Prompt budget the user set, if any.
 */
async function prepareRun(
  contextLength: number | undefined,
  { refuse = false, source = BIG_SOURCE, provider = 'custom-endpoint' } = {},
) {
  fixture = createStopContinueFixture(() => '', { isolation: 'none' });
  const target = fixture;
  mkdirSync(join(target.projectDir, 'src'), { recursive: true });
  writeFileSync(join(target.projectDir, BIG_FILE), source);
  execFileSync('git', ['add', BIG_FILE], { cwd: target.projectDir });
  execFileSync('git', ['commit', '--quiet', '-m', 'add the big module'], {
    cwd: target.projectDir,
  });
  const endpoint = await startEndpoint(refuse, source);

  const callsPath = join(target.tmpDir, 'calls.jsonl');
  const plannerPath = join(target.tmpDir, 'planner.mjs');
  const offlinePath = join(target.tmpDir, 'offline.mjs');
  writeFileSync(
    offlinePath,
    `const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === '127.0.0.1') return nativeFetch(input, options);
  throw new Error('Network disabled in prompt budget E2E');
};\n`,
  );
  vi.stubEnv('NODE_OPTIONS', `--import=${offlinePath}`);
  const plan = makePlanProposal({
    summary: 'Mark the big module done.',
    decisions: [],
    criteria: [{ id: 'C1', text: 'src/big.ts exports DONE.', checkIds: ['K1'] }],
    tasks: [
      makeTaskSpec({
        id: 'T001',
        title: 'Export DONE from the big module',
        intent: 'src/big.ts keeps every line and ends with an exported DONE flag.',
        criteria: ['C1'],
        suggestedFiles: [BIG_FILE],
        checks: [{ id: 'K1', kind: 'cmd', value: `test -f ${BIG_FILE}` }],
      }),
    ],
  });
  const passing = passingVerdict({ kind: 'final', taskIds: ['T001'], criterionIds: ['C1'] });
  writeFileSync(
    plannerPath,
    `import { appendFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
let kind;
let answer;
if (prompt.includes('# Task Implementation Review')) {
  kind = 'task-review';
  answer = ${JSON.stringify(passing)};
} else if (prompt.includes('# Final Implementation Review')) {
  kind = 'final-review';
  answer = ${JSON.stringify(passing)};
} else if (prompt.includes("The plan failed SPLITBRIEF's checks")) {
  kind = 'plan-repair';
  answer = ${JSON.stringify({ result: plan })};
} else if (prompt.includes('# Plan the change')) {
  kind = 'plan';
  answer = ${JSON.stringify({ result: plan })};
} else {
  throw new Error('Unexpected prompt: ' + prompt);
}
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ kind }) + '\\n');
process.stdout.write(JSON.stringify(answer));
`,
  );
  const config = loadConfig(target.projectDir).config;
  if (config.planner.kind !== 'shell') throw new Error('Expected the local shell planner fixture');
  writeConfig(target.projectDir, {
    ...config,
    planner: { ...config.planner, args: [plannerPath] },
    implementer: {
      kind: 'api',
      provider,
      service: provider,
      offering: 'payg',
      apiBase: endpoint.apiBase,
      apiKey: 'fixture-key',
      model: MODEL,
      ...(contextLength !== undefined && { contextLength }),
    },
    workflow: { ...config.workflow, review: 'task', approve: 'none' },
    validation: { ...config.validation, endChecks: false },
  });

  const readCalls = () =>
    readFileSync(callsPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => z.object({ kind: z.string() }).parse(JSON.parse(line)).kind);
  return { target, completions: endpoint.completions, readCalls };
}

describe('e2e: the Prompt budget of an API BUILD seat', () => {
  it('keeps the completed brief in state without writing usage analytics', async () => {
    const { target, completions } = await prepareRun(undefined, { source: TIGHT_SOURCE });

    const run = await cli(target, ['start', 'mark the big module done'], {
      json: true,
      timeoutMs: 60_000,
    });

    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(serverFailure).toBeUndefined();
    expect(completions).toHaveLength(1);
    const [sessionId] = readdirSync(sessionsRoot(target.projectDir));
    if (sessionId === undefined) throw new Error('The run saved no session');
    const ref = { projectDir: target.projectDir, sessionId };
    const dir = sessionDir(ref.projectDir, ref.sessionId);
    const state = z
      .looseObject({ taskBreakdowns: z.array(z.record(z.string(), z.unknown())) })
      .parse(JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8')));
    expect.soft(state).not.toHaveProperty('tokenUsage');
    expect(state.taskBreakdowns).toEqual([
      expect.objectContaining({
        taskId: 'T001',
        method: 'local',
        retryCount: 0,
        tool: 'custom-endpoint',
        kind: 'api',
        model: MODEL,
        implementerProfile: 'default',
      }),
    ]);
    for (const entry of state.taskBreakdowns) {
      expect
        .soft(Object.keys(entry).filter((key) => /token|cost|amount|estimate|rate$/i.test(key)))
        .toEqual([]);
    }

    const log = readFileSync(join(dir, SESSION_LOG_FILE), 'utf8');
    expect(log).toContain('"type":"task_completed"');
    expect.soft(log.match(/"type":"(?:cost_update|runner_call_usage)"/g)).toBeNull();
    expect(run.stdout).toContain('"type":"task_completed"');
    expect
      .soft(
        run.stdout.match(/"(?:[a-z]*(?:tokens?|cost|amount|pricing|estimated)[a-z]*|usage)"\s*:/gi),
      )
      .toBeNull();
    expect.soft(run.stdout.match(/"type":"(?:cost_update|runner_call_usage)"/g)).toBeNull();
    expect
      .soft(JSON.parse(readFileSync(reviewPacketJsonPath(ref), 'utf8')))
      .not.toHaveProperty('cost');
  });

  it('sends a brief over the assumed window whole when no Prompt budget is set, and ends it done', async () => {
    const { target, completions, readCalls } = await prepareRun(undefined, { provider: 'codex' });

    const run = await cli(target, ['start', 'mark the big module done']);

    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(serverFailure).toBeUndefined();
    expect(readCalls()).not.toContain('plan-repair');
    expect(completions).toHaveLength(1);
    expect(completions[0]?.model).toBe(MODEL);
    expect(completions[0]?.messages.map((message) => message.content).join('\n')).toContain(
      BIG_SOURCE,
    );
    const [sessionId] = readdirSync(sessionsRoot(target.projectDir));
    if (sessionId === undefined) throw new Error('The run saved no session');
    const state = readState(target, sessionId);
    expect(state.phase).toBe('complete');
    expect(state.tasks).toMatchObject([{ id: 'T001', status: 'done' }]);
    expect(readFileSync(join(target.projectDir, BIG_FILE), 'utf8')).toBe(BIG_SOURCE + DONE_LINE);
    const ref = { projectDir: target.projectDir, sessionId };
    const { events } = await readRunEvents(ref);
    const started = events.find((event) => event.type === 'task_started');
    expect(started).toMatchObject({ contextFit: 'overflow', backendKind: 'api', tool: 'codex' });
    expect(started?.routingReason).toMatch(
      /^Selected profile default \(overflow using conservative context-length fallback; no Prompt budget is set\)$/,
    );
    const markdown = readFileSync(reviewPacketMarkdownPath(ref), 'utf8');
    const routing = markdown.split('## Routing\n')[1]?.split('\n## ')[0];
    expect(routing).toContain('- Per-task routing entries: 1');
    expect.soft(routing).not.toMatch(/^- T001: OpenAI Codex CLI\b/m);
    expect.soft(routing).toMatch(/^- T001: codex · .+ · default · Selected profile default/m);
    const packet = ReviewPacketSchema.parse(
      JSON.parse(readFileSync(reviewPacketJsonPath(ref), 'utf8')),
    );
    expect(packet.routing.taskRouting).toMatchObject([
      { taskId: 'T001', tool: 'codex', kind: 'api', model: MODEL },
    ]);
  });

  it('stops the brief at the plan check when it does not fit the Prompt budget the user set', async () => {
    const { target, completions, readCalls } = await prepareRun(4096);

    const run = await cli(target, ['start', 'mark the big module done']);

    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(1);
    expect(readCalls()).toEqual(['plan', 'plan-repair']);
    expect(completions).toEqual([]);
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname === '127.0.0.1') return nativeFetch(input, init);
      return Promise.reject(new Error('Network disabled in prompt budget E2E'));
    });
    const opened = await openHaltedRun(target, { heading: FIT_ERROR });
    ui = opened.screen;
    expect(loadState(opened.ref)?.pendingRecovery?.reason).toBe('plan-checks-failed');
    expect(opened.screen.lastFrame()).toMatch(
      /The brief needs about [\d,]+ tokens\.\s+The BUILD seat can take at most 4,096\./,
    );
  });

  it('stops the brief at the plan check when SPLITBRIEF_CONTEXT_LENGTH sets a Prompt budget it does not fit', async () => {
    const { target, completions, readCalls } = await prepareRun(undefined);
    vi.stubEnv('SPLITBRIEF_CONTEXT_LENGTH', '4096');

    const run = await cli(target, ['start', 'mark the big module done']);

    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(1);
    expect(readCalls()).toEqual(['plan', 'plan-repair']);
    expect(completions).toEqual([]);
    const [sessionId] = readdirSync(sessionsRoot(target.projectDir));
    if (sessionId === undefined) throw new Error('The run saved no session');
    expect(readState(target, sessionId).pendingRecovery?.reason).toBe('plan-checks-failed');
    expect(loadConfig(target.projectDir).config.implementer.contextLength).toBeUndefined();
  });

  it('halts at once on the Prompt too large card when the provider refuses the whole brief, and keeps the brief row', async () => {
    const { target, completions } = await prepareRun(undefined, { refuse: true });

    const run = await cli(target, ['start', 'mark the big module done']);

    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(1);
    expect(completions).toHaveLength(1);
    const [sessionId] = readdirSync(sessionsRoot(target.projectDir));
    if (sessionId === undefined) throw new Error('The run saved no session');
    const recovery = readState(target, sessionId).pendingRecovery;
    expect(recovery).toMatchObject({ reason: 'context-overflow', taskId: 'T001' });
    expect(recovery?.message).toMatch(/^Prompt too large for .+ on T001$/);
    expect(recovery?.details).toContain('Attempts: 1');
    const { events } = await readRunEvents({ projectDir: target.projectDir, sessionId });
    // Ink paints the transcript 80 columns wide, so the rows wrap at 80 too.
    const transcript = transcriptText(events, 80);
    expect(transcript).toContain('src/big.ts (modify)');
    expect(transcript).not.toContain('(overflow)');
  });
});
