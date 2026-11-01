import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { detectAvailableCliTools } from '../../../src/engine/detection/detect.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { guidanceConsult, passingVerdict } from '#testing/helpers/typed-planner.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { installPlannerClaude, type PlanSeatCall } from '../helpers/claude-plan-seat.js';
import {
  cli,
  createStopContinueFixture,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const DECISION = 'Keep the greeting in one module';
const REPORTED = { what: 'Kept the test beside the module', why: 'The other tests live there.' };
const GREET = 'src/greet.mjs';
const GREET_TEST = 'src/greet.test.mjs';
const greeting = makeTaskSpec({
  id: 'T001',
  title: 'Add the greeting',
  intent: 'Return a greeting.',
  criteria: ['C1'],
  suggestedFiles: [GREET, GREET_TEST],
  checks: [{ id: 'T001-K1', kind: 'test', value: GREET_TEST, required: true }],
});
const plan = {
  result: makePlanProposal({
    summary: 'Add one tested greeting.',
    decisions: [DECISION],
    criteria: [{ id: 'C1', text: 'greet returns hello.', checkIds: ['T001-K1'] }],
    tasks: [greeting],
  }),
};
const FILES = {
  [GREET_TEST]:
    "import { strict as assert } from 'node:assert';\nimport { greet } from './greet.mjs';\nassert.equal(greet(), 'hello');\n",
  [GREET]: "export const greet = () => 'hello';\n",
};

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;
let trustHome: ReturnType<typeof useTrustHome> | undefined;

beforeEach(() => {
  trustHome = useTrustHome('e2e-resumed-consult-home');
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

/** The first attempt and its retry write the test but not the greeting, so the brief's test fails twice and PLAN is consulted. */
function implementerScript(attempts: string): string {
  return `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
const attempt = existsSync(${JSON.stringify(attempts)}) ? readFileSync(${JSON.stringify(attempts)}, 'utf8').length : 0;
appendFileSync(${JSON.stringify(attempts)}, 'x');
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(GREET_TEST)}, ${JSON.stringify(FILES[GREET_TEST])});
if (attempt > 1) writeFileSync(${JSON.stringify(GREET)}, ${JSON.stringify(FILES[GREET])});
console.log(JSON.stringify({
  status: 'done',
  filesChanged: [${JSON.stringify(GREET_TEST)}],
  touchedNotSuggested: [],
  notes: null,
  decisions: [${JSON.stringify(REPORTED)}],
}));
`;
}

describe('e2e: the resumed consult names the decision ledger', { timeout: 240_000 }, () => {
  it('sends the plan decisions under Decisions when the consult resumes the planning session', async () => {
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
    installPlannerClaude(binDir, callsPath, {
      plan,
      review: passingVerdict({ kind: 'final', taskIds: [greeting.id], criterionIds: ['C1'] }),
      consult: guidanceConsult('Write the greeting as the brief says.'),
      refusal: 'none',
    });
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
      "globalThis.fetch = async () => { throw new Error('Network disabled in resumed consult E2E'); };\n",
    );
    vi.stubEnv('NODE_OPTIONS', `--import=${offline}`);

    const run = await cli(target, ['start', 'smoke'], { timeoutMs: 150_000 });
    const [sessionId] = readdirSync(sessionsRoot(target.projectDir));
    if (sessionId === undefined) throw new Error(`the run left no session: ${run.stderr}`);
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
    const calls: PlanSeatCall[] = existsSync(callsPath)
      ? readFileSync(callsPath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as PlanSeatCall)
      : [];

    const resumedConsult = calls.find(
      (call) => call.kind === 'consult' && call.resumed === 'planner-session',
    );
    expect(
      resumedConsult,
      JSON.stringify(calls.map(({ kind, resumed }) => ({ kind, resumed }))),
    ).toBeDefined();
    const prompt = resumedConsult?.prompt ?? '';
    expect(prompt).toMatch(/^# Consult continued$/m);
    expect(prompt).toMatch(new RegExp(`^## Decisions\\n+- ${DECISION}$`, 'm'));
    expect(prompt).toContain(
      `- ${DECISION}\n- ${REPORTED.what} — ${REPORTED.why} (${greeting.id})\n`,
    );
    expect(prompt).not.toContain('Confirmed Decisions');
  });
});
