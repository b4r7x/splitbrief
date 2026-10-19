import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { deriveRunStatus } from '../../../src/core/sessions/run-status.js';
import { detectAvailableCliTools } from '../../../src/engine/detection/detect.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { guidanceConsult, passingVerdict } from '#testing/helpers/typed-planner.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import {
  cli,
  createStopContinueFixture,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const GENERATED_FILE = 'src/generated.json';
/** The consult prompt size the fake planner tool refuses as too long. */
const REFUSED_CHARS = 500_000;

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;
let trustHome: ReturnType<typeof useTrustHome> | undefined;

beforeEach(() => {
  trustHome = useTrustHome('e2e-consult-refused-home');
});

afterEach(() => {
  vi.unstubAllEnvs();
  restorePath?.();
  trustHome?.restore();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
  trustHome = undefined;
});

const GREET = 'src/greet.mjs';
const GREET_TEST = 'src/greet.test.mjs';
const greeting = makeTaskSpec({
  id: 'T001',
  title: 'Add the greeting',
  intent: 'Return a greeting.',
  criteria: ['C1'],
  suggestedFiles: [GREET, GREET_TEST, GENERATED_FILE],
  checks: [{ id: 'T001-K1', kind: 'test', value: GREET_TEST, required: true }],
});
const plan = {
  result: makePlanProposal({
    summary: 'Add one tested greeting and its generated data.',
    decisions: [],
    criteria: [{ id: 'C1', text: 'greet returns hello.', checkIds: ['T001-K1'] }],
    tasks: [greeting],
  }),
};
const FILES = {
  [GREET_TEST]:
    "import { strict as assert } from 'node:assert';\nimport { greet } from './greet.mjs';\nassert.equal(greet(), 'hello');\n",
  [GREET]: "export const greet = () => 'hello';\n",
};

/**
 * The first attempt and its retry each write a new 3 MB generated file and the test but not
 * the greeting, so the brief's test fails twice and PLAN is consulted. Every later attempt writes
 * the greeting too.
 */
function implementerScript(attempts: string): string {
  return `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
const attempt = existsSync(${JSON.stringify(attempts)}) ? readFileSync(${JSON.stringify(attempts)}, 'utf8').length : 0;
appendFileSync(${JSON.stringify(attempts)}, 'x');
mkdirSync('src', { recursive: true });
const rows = Array.from({ length: 40000 }, (_, i) => '  "row-' + attempt + '-' + i + '-' + 'x'.repeat(60) + '"');
writeFileSync(${JSON.stringify(GENERATED_FILE)}, '[\\n' + rows.join(',\\n') + '\\n]\\n');
writeFileSync(${JSON.stringify(GREET_TEST)}, ${JSON.stringify(FILES[GREET_TEST])});
if (attempt > 1) writeFileSync(${JSON.stringify(GREET)}, ${JSON.stringify(FILES[GREET])});
`;
}

type Refusal = 'oversized' | 'planner-session' | 'every-consult';

/**
 * Claude Code as the PLAN seat, at a version that takes typed answers natively. The plan call opens the session `planner-session`; every other
 * call that resumes nothing opens `fresh-session`. A refused call ends the way Claude Code
 * refused an oversized prompt live: an `is_error` result that says only "Prompt is too long",
 * and exit 1. Each call is logged with its arguments, its prompt length and its kind.
 */
function installPlannerClaude(binDir: string, calls: string, refusal: Refusal): void {
  const review = passingVerdict({ kind: 'final', taskIds: [greeting.id], criterionIds: ['C1'] });
  const consult = guidanceConsult('Write the greeting as the brief says.');
  writeFakeNodeCli(
    binDir,
    'claude',
    `const { appendFileSync, readFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('claude 2.1.296');
  process.exit(0);
}
if (args[0] === 'auth') {
  console.log(JSON.stringify({ loggedIn: true }));
  process.exit(0);
}
const refusal = ${JSON.stringify(refusal)};
const resumeAt = args.indexOf('--resume');
const resumed = resumeAt === -1 ? null : args[resumeAt + 1];
const emit = (entry) => console.log(JSON.stringify(entry));
const answer = (prompt) => {
  const kind = /^# (Final|Task) Implementation Review$/m.test(prompt)
    ? 'review'
    : /^# Consult (on a failing task|continued)$/m.test(prompt)
      ? 'consult'
      : args.includes('--json-schema')
        ? 'plan'
        : 'summary';
  const session = resumed ?? (kind === 'plan' ? 'planner-session' : 'fresh-session');
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify({
    kind,
    args: args.filter((arg) => !arg.startsWith('{')),
    resumed,
    length: prompt.length,
    namesGenerated: prompt.includes(${JSON.stringify(GENERATED_FILE)}),
  }) + '\\n');
  emit({ type: 'system', subtype: 'init', session_id: session });
  if (args.includes('--input-format')) {
    emit({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: prompt } });
  }
  const refused =
    kind === 'consult' &&
    ((refusal === 'oversized' && prompt.length > ${REFUSED_CHARS}) ||
      (refusal === 'planner-session' && resumed === 'planner-session') ||
      refusal === 'every-consult');
  if (refused) {
    emit({ type: 'result', is_error: true, result: 'Prompt is too long', session_id: session, usage: { input_tokens: 0, output_tokens: 0 } });
    process.exitCode = 1;
    return;
  }
  const typed = kind === 'plan' ? ${JSON.stringify(plan)} : kind === 'consult' ? ${JSON.stringify(consult)} : kind === 'review' ? ${JSON.stringify(review)} : null;
  emit({
    type: 'result',
    session_id: session,
    result: typed === null ? 'Summary complete' : JSON.stringify(typed),
    ...(typed === null ? {} : { structured_output: typed }),
    usage: { input_tokens: 10, output_tokens: 5 },
  });
};
if (args.includes('--input-format')) {
  const lines = require('node:readline').createInterface({ input: process.stdin });
  lines.once('line', (line) => {
    const content = JSON.parse(line).message.content;
    answer(typeof content === 'string' ? content : JSON.stringify(content));
    lines.close();
    process.stdin.destroy();
  });
} else {
  answer(readFileSync(0, 'utf8'));
}`,
  );
}

type Call = {
  kind: string;
  args: string[];
  resumed: string | null;
  length: number;
  namesGenerated: boolean;
};

async function runWithPlannerClaude(refusal: Refusal) {
  fixture = createStopContinueFixture(
    (projectDir) => implementerScript(join(projectDir, '..', 'attempts')),
    { isolation: 'worktree' },
  );
  const target = fixture;
  const home = trustHome?.home;
  if (home === undefined) throw new Error('the trust home is not set up');
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', '.credentials.json'), '{"fixture":true}\n');
  const binDir = join(target.tmpDir, 'bin');
  mkdirSync(binDir);
  const callsPath = join(target.tmpDir, 'planner-calls.jsonl');
  installPlannerClaude(binDir, callsPath, refusal);
  restorePath = activateSafeCliShimPath(binDir);

  const config = loadConfig(target.projectDir).config;
  writeConfig(target.projectDir, {
    ...config,
    planner: { kind: 'cli', tool: 'claude-code', model: 'sonnet' },
    validation: { ...config.validation, testCommand: 'node --test' },
    // The brief's own checks run after each attempt only on the per-task review cadence.
    workflow: { ...config.workflow, review: 'task' },
  });
  const tools = await detectAvailableCliTools({
    projectDir: target.projectDir,
    tools: ['claude-code'],
    authChannels: { 'claude-code': 'session' },
    role: 'planner',
  });
  expect(tools[0]?.diagnostic.state, JSON.stringify(tools[0]?.diagnostic)).toBe('ready');
  await rememberDetectedTools(target.projectDir, tools);
  const offline = join(target.tmpDir, 'offline.mjs');
  writeFileSync(
    offline,
    "globalThis.fetch = async () => { throw new Error('Network disabled in consult refusal E2E'); };\n",
  );
  vi.stubEnv('NODE_OPTIONS', `--import=${offline}`);

  const run = await cli(target, ['start', 'smoke'], { timeoutMs: 150_000 });
  const [sessionId] = readdirSync(sessionsRoot(target.projectDir));
  if (sessionId === undefined) throw new Error(`the run left no session: ${run.stderr}`);
  const calls: Call[] = existsSync(callsPath)
    ? readFileSync(callsPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Call)
    : [];
  return { run, state: readState(target, sessionId), calls };
}

describe('e2e: the planner tool refuses a consult as too long', { timeout: 240_000 }, () => {
  it('sends a consult after a 3 MB change under the limit, names the generated file, and the run becomes ready to apply', async () => {
    const { run, state, calls } = await runWithPlannerClaude('oversized');

    const consults = calls.filter((call) => call.kind === 'consult');
    expect(consults.length, JSON.stringify(calls)).toBeGreaterThan(0);
    for (const consult of consults) {
      expect(consult, JSON.stringify(consults)).toMatchObject({ namesGenerated: true });
      expect(consult.length).toBeLessThan(REFUSED_CHARS);
    }
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(deriveRunStatus({ state, liveness: 'not-alive' })).toEqual({
      kind: 'ready-to-apply',
      override: false,
    });
  });

  it('asks again on a fresh session when the tool refuses the resumed planning thread, and the run continues', async () => {
    const { run, state, calls } = await runWithPlannerClaude('planner-session');

    const refusedAt = calls.findIndex(
      (call) => call.kind === 'consult' && call.resumed === 'planner-session',
    );
    expect(refusedAt, JSON.stringify(calls)).toBeGreaterThan(-1);
    expect(calls[refusedAt + 1]).toMatchObject({ kind: 'consult', resumed: null });
    expect(calls.slice(refusedAt + 1).map((call) => call.resumed)).not.toContain('planner-session');
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(deriveRunStatus({ state, liveness: 'not-alive' })).toEqual({
      kind: 'ready-to-apply',
      override: false,
    });
  });

  it('halts without Try again when the tool refuses every consult', async () => {
    const { run, state, calls } = await runWithPlannerClaude('every-consult');

    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(1);
    const issue = state.pendingRecovery;
    expect(issue?.reason, JSON.stringify({ issue, calls })).toBe('planner-call-failed');
    expect(issue?.availableActions).not.toContain('retry-same-worker');
    expect(issue?.details).toContainEqual(expect.stringContaining('A retry sends the same prompt'));
  });
});
