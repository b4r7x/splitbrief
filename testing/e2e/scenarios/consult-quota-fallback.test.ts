import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool/catalog.js';
import { deriveRunStatus } from '../../../src/core/sessions/run/status.js';
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
import {
  cli,
  createStopContinueFixture,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';
import { transcriptText } from '../helpers/transcript-text.js';

const RUN_TIMEOUT_MS = 150_000;
const PRIMARY_MODEL = 'gemini-3.1-pro-high';
const FALLBACK_MODEL = 'gemini-3.8-flash-high';
const MODEL_LISTING = readFileSync(
  join(import.meta.dirname, '../../fixtures/antigravity/models.txt'),
  'utf8',
);
const QUOTA_CONVERSATION = '0f4ac269-acaf-439b-b86e-844d3e91e99a';
const QUOTA_WORDS =
  'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 144h5m54s.';
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
  suggestedFiles: [ALPHA_FILE, ALPHA_TEST],
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

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;
let trustHome: ReturnType<typeof useTrustHome> | undefined;

beforeEach(() => {
  resetAllStores();
  trustHome = useTrustHome('e2e-consult-quota-fallback-home');
});

afterEach(() => {
  resetAllStores();
  vi.unstubAllEnvs();
  restorePath?.();
  trustHome?.restore();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
  trustHome = undefined;
});

/**
 * The implementer writes the brief's test and a value the test rejects, until its prompt carries
 * the consult guidance. Each call logs the file it found and whether it had the guidance.
 */
function implementerScript(calls: string): string {
  return `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const guided = prompt.includes(${JSON.stringify(GUIDANCE)});
const before = existsSync(${JSON.stringify(ALPHA_FILE)}) ? readFileSync(${JSON.stringify(ALPHA_FILE)}, 'utf8') : null;
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ kind: 'implement', before, guided }) + '\\n');
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(ALPHA_TEST)}, ${JSON.stringify(ALPHA_TEST_SOURCE)});
writeFileSync(${JSON.stringify(ALPHA_FILE)}, guided ? ${JSON.stringify(GUIDED_ALPHA)} : ${JSON.stringify(WRONG_ALPHA)});
console.log('Implemented T001');
`;
}

/**
 * agy as the PLAN seat. It plans the one brief and passes every review. A consult on the primary
 * model stops on the quota the way agy 1.4.7 did in a recorded run: an `error_message` step, a
 * failed result frame and exit 3. A consult on the fallback model answers with guidance. Each
 * consult logs its model.
 */
function installPlannerAgy(binDir: string, calls: string): void {
  const errorStep = {
    event: 'step_update',
    step_update: {
      conversation_id: QUOTA_CONVERSATION,
      step_index: 1,
      state: 'DONE',
      step_type: 'error_message',
      error_message: {
        error_id: 'd7bcf3b5-ecdd-44a7-a3cf-b9e4b44d835f-1',
        message: QUOTA_WORDS,
        short_error: `RESOURCE_EXHAUSTED (code 429): ${QUOTA_WORDS}`,
      },
    },
  };
  writeFakeNodeCli(
    binDir,
    'agy',
    `const { appendFileSync, readFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write(${JSON.stringify(`${CLI_TOOL_CATALOG.antigravity.compatibility.testedVersion}\n`)});
} else if (args[0] === 'models') {
  process.stdout.write(${JSON.stringify(MODEL_LISTING)});
} else {
  answer();
}
function answer() {
  if (!args.includes('--output-format')) throw new Error('Unexpected agy invocation: ' + args.join(' '));
  const model = args[args.indexOf('--model') + 1];
  if (model !== ${JSON.stringify(PRIMARY_MODEL)} && model !== ${JSON.stringify(FALLBACK_MODEL)}) {
    throw new Error('Unexpected model: ' + model);
  }
  const prompt = JSON.parse(readFileSync(0, 'utf8')).message.content;
  const emit = (record) => process.stdout.write(JSON.stringify(record) + '\\n');
  const kind = /^# (Final|Task) Implementation Review$/m.test(prompt)
    ? 'review'
    : /^# Consult (on a failing task|continued)$/m.test(prompt)
      ? 'consult'
      : args.includes('--json-schema')
        ? 'plan'
        : 'summary';
  const conversation = kind === 'consult' ? ${JSON.stringify(QUOTA_CONVERSATION)} : 'agy-' + kind;
  emit({ event: 'init', conversation_id: conversation });
  emit({ event: 'step_update', step_update: { conversation_id: conversation, step_index: 0, state: 'DONE', step_type: 'user_input' } });
  if (kind === 'consult') {
    appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ kind: 'consult', model }) + '\\n');
    if (model === ${JSON.stringify(PRIMARY_MODEL)}) {
      emit(${JSON.stringify(errorStep)});
      emit({ event: 'result', result: { conversation_id: conversation, status: 'ERROR', error: ${JSON.stringify(QUOTA_WORDS)} } });
      process.exitCode = 3;
      return;
    }
  }
  const typed = kind === 'plan'
    ? ${JSON.stringify(plan)}
    : kind === 'review'
      ? ${JSON.stringify(passingVerdict({ kind: 'final', taskIds: [alpha.id], criterionIds: ['C1'] }))}
      : kind === 'consult'
        ? ${JSON.stringify(guidanceConsult(GUIDANCE))}
        : null;
  emit({
    event: 'result',
    result: {
      conversation_id: conversation,
      status: 'SUCCESS',
      response: typed === null ? 'Summary complete' : JSON.stringify(typed),
      ...(typed === null ? {} : { structured_output: typed }),
      usage: { input_tokens: 100, output_tokens: 40 },
    },
  });
}`,
  );
}

function readCalls(calls: string): unknown[] {
  return readFileSync(calls, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// agy keeps its sign-in in the macOS login keychain; its session channel exists only on macOS.
describe.runIf(process.platform === 'darwin')(
  'e2e: a consult that stops on the PLAN tool quota',
  { timeout: 240_000 },
  () => {
    it('continues on the declared PLAN fallback with a consult on the files the attempt left', async () => {
      fixture = createStopContinueFixture(
        (projectDir) => implementerScript(join(projectDir, '..', 'calls.jsonl')),
        { isolation: 'worktree' },
      );
      const target = fixture;
      const callsPath = join(target.tmpDir, 'calls.jsonl');
      writeFileSync(callsPath, '');
      const binDir = join(target.tmpDir, 'bin');
      mkdirSync(binDir);
      installPlannerAgy(binDir, callsPath);
      restorePath = activateSafeCliShimPath(binDir);

      const config = loadConfig(target.projectDir).config;
      writeConfig(target.projectDir, {
        ...config,
        planner: {
          kind: 'cli',
          tool: 'antigravity',
          model: PRIMARY_MODEL,
          fallback: { tool: 'antigravity', model: FALLBACK_MODEL },
        },
        validation: { ...config.validation, testCommand: 'node --test' },
        // The brief's own checks run after each attempt only on the per-task review cadence.
        workflow: { ...config.workflow, review: 'task' },
      });
      const tools = await detectAvailableCliTools({
        projectDir: target.projectDir,
        tools: ['antigravity'],
        role: 'planner',
      });
      expect(tools[0]?.diagnostic.state, JSON.stringify(tools[0]?.diagnostic)).toBe('ready');
      await rememberDetectedTools(target.projectDir, tools);
      const offline = join(target.tmpDir, 'offline.mjs');
      writeFileSync(
        offline,
        "globalThis.fetch = async () => { throw new Error('Network disabled in consult quota E2E'); };\n",
      );
      vi.stubEnv('NODE_OPTIONS', `--import=${offline}`);

      const run = await cli(target, ['start', 'smoke'], { timeoutMs: RUN_TIMEOUT_MS });

      const [sessionId] = readdirSync(sessionsRoot(target.projectDir));
      if (sessionId === undefined) throw new Error(`the run left no session: ${run.stderr}`);
      const state = readState(target, sessionId);
      // The fallback consult comes before any BUILD call and sees the attempt's file.
      expect(readCalls(callsPath)).toEqual([
        { kind: 'implement', before: null, guided: false },
        { kind: 'consult', model: PRIMARY_MODEL },
        { kind: 'consult', model: FALLBACK_MODEL },
        { kind: 'implement', before: WRONG_ALPHA, guided: true },
      ]);
      expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
      expect(deriveRunStatus({ reviewNone: false, state, liveness: 'not-alive' })).toEqual({
        kind: 'ready-to-apply',
        override: false,
      });
      expect(state.seatSwitches).toEqual([
        expect.objectContaining({ seat: 'plan', cause: 'runner-usage-limit', auto: true }),
      ]);
      const workspaceDir = state.workspace?.path;
      if (workspaceDir === undefined) throw new Error('the run recorded no workspace');
      expect(readFileSync(join(workspaceDir, ALPHA_FILE), 'utf8')).toBe(GUIDED_ALPHA);

      const { events } = await readRunEvents({ projectDir: target.projectDir, sessionId });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'recovery_prompted',
          taskId: 'T001',
          reason: 'runner-usage-limit',
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'seat_switched',
          seat: 'plan',
          auto: true,
          from: { tool: 'antigravity', model: PRIMARY_MODEL },
          to: expect.objectContaining({ tool: 'antigravity', model: FALLBACK_MODEL }),
        }),
      );
      const resolvedAt = events.findIndex((event) => event.type === 'recovery_resolved');
      expect(resolvedAt).toBeGreaterThan(-1);
      expect(
        events.slice(resolvedAt + 1).find((event) => event.type === 'runner_call_started'),
      ).toMatchObject({
        role: 'planner',
        runnerName: 'antigravity',
        model: FALLBACK_MODEL,
        taskId: 'T001',
      });
      expect(events).not.toContainEqual(
        expect.objectContaining({ type: 'warning', message: expect.stringMatching(/^Restored /) }),
      );
      expect(JSON.stringify(events)).not.toContain('Unknown Antigravity step');

      const transcript = transcriptText(events);
      const lines = transcript.split('\n');
      const flat = transcript.replace(/\s+/g, ' ');
      expect(flat).toContain('Recovery Usage limit on Google Antigravity CLI');
      expect(flat).toContain('continued on fallback');
      expect(transcript.match(/Recovery {2}/g)).toHaveLength(1);
      expect(transcript).not.toContain('of the failing brief');
      expect(transcript).not.toContain('Unknown Antigravity step');
      const recoveryAt = lines.findIndex((line) => line.includes('Recovery  '));
      const consultRows = lines.filter((line) => /PLAN \S+ T001: guidance/.test(line));
      expect(consultRows).toHaveLength(1);
      expect(lines.indexOf(consultRows[0] ?? '')).toBeGreaterThan(recoveryAt);
    });
  },
);
