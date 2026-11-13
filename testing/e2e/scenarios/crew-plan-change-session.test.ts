import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { detectAvailableCliTools } from '../../../src/engine/detection/detect.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { guidanceConsult, passingVerdict } from '#testing/helpers/typed-planner.js';
import { installPlannerClaude, type PlanSeatCall } from '../helpers/claude-plan-seat.js';
import {
  continueRun,
  createStopContinueFixture,
  MARKER_FILE,
  MARKER_SOURCE,
  readState,
  startAndSignal,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';
import { transcriptText } from '../helpers/transcript-text.js';

/** The thread codex reports for every PLAN call; the run saves it as its planner session. */
const RETIRED_THREAD = 'retired-plan-thread';
/** How long the first BUILD call holds if no kill ends it; a backstop, not a pace. */
const HOLD_MS = 120_000;
const GUIDANCE = 'Export the string alpha from src/alpha.mjs.';

const ALPHA_FILE = 'src/alpha.mjs';
const ALPHA_TEST = 'src/alpha.test.mjs';
const WRONG_ALPHA = "export const alpha = 'not alpha';\n";
const GUIDED_ALPHA = "export const alpha = 'alpha';\n";
const ALPHA_TEST_SOURCE =
  "import { strict as assert } from 'node:assert';\nimport { alpha } from './alpha.mjs';\nassert.equal(alpha, 'alpha');\n";

const alpha = makeTaskSpec({
  id: 'T001',
  title: 'Add the alpha value',
  intent: 'Return the alpha value.',
  criteria: ['C1'],
  suggestedFiles: [ALPHA_FILE, ALPHA_TEST, MARKER_FILE],
  checks: [{ id: 'T001-K1', kind: 'test', value: ALPHA_TEST }],
});
const plan = {
  result: makePlanProposal({
    summary: 'Add one tested value.',
    decisions: [],
    criteria: [{ id: 'C1', text: 'Alpha is the string alpha.', checkIds: ['T001-K1'] }],
    tasks: [alpha],
  }),
};
const verdict = passingVerdict({ kind: 'final', taskIds: [alpha.id], criterionIds: ['C1'] });

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;
let trustHome: ReturnType<typeof useTrustHome> | undefined;

afterEach(() => {
  if (fixture !== undefined) writeFileSync(fixture.releaseHoldPath, '');
  vi.unstubAllEnvs();
  restorePath?.();
  trustHome?.restore();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
  trustHome = undefined;
  resetAllStores();
});

/**
 * Every BUILD call writes the brief's test, the marker and a value the test rejects, until its
 * prompt carries the consult guidance. The first call then holds, so the run is killed inside it.
 * Each call logs whether it had the guidance.
 */
function implementerScript(tmpDir: string): string {
  const calls = join(tmpDir, 'implementer-calls.jsonl');
  return `import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const guided = Buffer.concat(chunks).toString('utf8').includes(${JSON.stringify(GUIDANCE)});
const first = !existsSync(${JSON.stringify(calls)});
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ guided }) + '\\n');
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(ALPHA_TEST)}, ${JSON.stringify(ALPHA_TEST_SOURCE)});
writeFileSync(${JSON.stringify(ALPHA_FILE)}, guided ? ${JSON.stringify(GUIDED_ALPHA)} : ${JSON.stringify(WRONG_ALPHA)});
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
const release = ${JSON.stringify(join(tmpDir, 'release-implementer'))};
const deadline = Date.now() + ${HOLD_MS};
while (first && !existsSync(release) && Date.now() < deadline) await delay(50);
console.log('Implemented T001');
`;
}

/** Codex as the PLAN seat the run starts on: it plans the one brief on the thread it reports. */
function installPlannerCodex(binDir: string): void {
  writeFakeNodeCli(
    binDir,
    'codex',
    `const { readFileSync } = require('node:fs');
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
const emit = (entry) => console.log(JSON.stringify(entry));
emit({ type: 'thread.started', thread_id: ${JSON.stringify(RETIRED_THREAD)} });
emit({ type: 'item.completed', item: { type: 'agent_message', text: ${JSON.stringify(JSON.stringify(plan))} } });
emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } });`,
  );
}

function readLines<T>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

describe('e2e: a PLAN seat moved with /crew before a killed run continues', {
  timeout: 240_000,
}, () => {
  it('consults the new PLAN tool on a fresh session and shows no expired-session warning', async () => {
    fixture = createStopContinueFixture((projectDir) => implementerScript(dirname(projectDir)));
    const target = fixture;
    trustHome = useTrustHome('e2e-crew-plan-change-home');
    mkdirSync(join(trustHome.home, '.codex'), { recursive: true });
    writeFileSync(join(trustHome.home, '.codex', 'auth.json'), '{"fixture":true}\n');
    mkdirSync(join(trustHome.home, '.claude'), { recursive: true });
    writeFileSync(join(trustHome.home, '.claude', '.credentials.json'), '{"fixture":true}\n');
    const binDir = join(target.tmpDir, 'bin');
    mkdirSync(binDir);
    const claudeCalls = join(target.tmpDir, 'claude-calls.jsonl');
    writeFileSync(claudeCalls, '');
    installPlannerCodex(binDir);
    installPlannerClaude(binDir, claudeCalls, {
      plan,
      review: verdict,
      consult: guidanceConsult(GUIDANCE),
      refusal: 'unknown-session',
    });
    restorePath = activateSafeCliShimPath(binDir);

    const config = loadConfig(target.projectDir).config;
    writeConfig(target.projectDir, {
      ...config,
      planner: { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' },
      validation: { ...config.validation, testCommand: 'node --test' },
      // The brief's own checks run after each attempt only on the per-task review cadence.
      workflow: { ...config.workflow, review: 'task' },
    });
    const tools = await detectAvailableCliTools({
      projectDir: target.projectDir,
      tools: ['codex', 'claude-code'],
      authChannels: { codex: 'session', 'claude-code': 'session' },
      role: 'planner',
    });
    expect(Object.fromEntries(tools.map((tool) => [tool.tool, tool.diagnostic.state]))).toEqual({
      codex: 'ready',
      'claude-code': 'ready',
    });
    await rememberDetectedTools(target.projectDir, tools);
    const offline = join(target.tmpDir, 'offline.mjs');
    writeFileSync(
      offline,
      "globalThis.fetch = async () => { throw new Error('Network disabled in crew plan change E2E'); };\n",
    );
    vi.stubEnv('NODE_OPTIONS', `--import=${offline}`);

    const killed = await startAndSignal(target, 'SIGKILL', target.isolationTreesDir);
    expect(killed.exitCode).toBeNull();
    const ref = { projectDir: target.projectDir, sessionId: killed.sessionId };
    // The kill leaves the brief in flight with no park, and the codex thread saved.
    const killedState = readState(target, killed.sessionId);
    expect(killedState.plannerSessionId).toBe(RETIRED_THREAD);
    expect(killedState.interruptedStep).toBeUndefined();
    expect(killedState.tasks).toMatchObject([{ id: 'T001', status: 'in_progress' }]);

    // What `/crew plan` saves: the PLAN block in config.yaml, on another tool.
    writeConfig(target.projectDir, {
      ...loadConfig(target.projectDir).config,
      planner: { kind: 'cli', tool: 'claude-code', model: 'sonnet' },
    });
    const resumed = await continueRun(target);
    expect(resumed.exitCode, `${resumed.stdout}\n${resumed.stderr}`).toBe(0);

    const { events } = await readRunEvents(ref);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'seat_switched', seat: 'plan', cause: 'crew-changed' }),
    );
    expect(
      events.filter((event) => 'code' in event && event.code === 'planner_session_expired'),
    ).toEqual([]);
    const calls = readLines<PlanSeatCall>(claudeCalls);
    expect(calls.filter((call) => call.resumed !== null)).toEqual([]);
    expect(calls).toContainEqual(expect.objectContaining({ kind: 'consult', resumed: null }));
    expect(readLines(join(target.tmpDir, 'implementer-calls.jsonl')).at(-1)).toEqual({
      guided: true,
    });
    expect(readState(target, killed.sessionId).tasks).toMatchObject([
      { id: 'T001', status: 'done' },
    ]);
    expect(transcriptText(events)).not.toContain('Planner session expired');
    expect(`${resumed.stdout}\n${resumed.stderr}`).not.toContain('Planner session expired');
  });
});
