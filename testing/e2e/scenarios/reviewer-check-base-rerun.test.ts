import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { readEvidenceLedger } from '../../../src/core/evidence/ledger-storage.js';
import {
  REVIEW_FILE,
  reviewPacketJsonPath,
  reviewPacketMarkdownPath,
  sessionDir,
  sessionsRoot,
} from '../../../src/core/paths.js';
import type { Finding } from '../../../src/core/review/verdict.js';
import { ReviewPacketSchema } from '../../../src/core/schemas/review-packet.js';
import { groupEventsIntoSections } from '../../../src/core/sections/event-sections.js';
import { readRunRecord } from '../../../src/core/sessions/run-record-io.js';
import { deriveRunStatus } from '../../../src/core/sessions/run-status.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { factSpans, runRows } from '../../../src/features/workflow/closed/copy.js';
import { deriveSummaryView } from '../../../src/features/workflow/closed/view-model.js';
import { rowText } from '../../../src/features/workflow/conversation-rows/row-format/rows.js';
import { suiteStatusParts } from '../../../src/features/workflow/display/phase-verb.js';
import { hydrateRun } from '../../../src/features/workflow/run-history.js';
import { eventsStore } from '../../../src/stores/workflow/events.js';
import { buildConversationRows } from '#testing/helpers/event-rows.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import { assertPlainStdout } from '../helpers/run-dir-assertions.js';
import {
  applyRun,
  cli,
  createStopContinueFixture,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const SCRIPT_RED_KEY =
  'legacy/report-check.mjs:4:3 AssertionError: legacy report total expected 3, received 2';

/**
 * The committed reds the run base already holds: a script that prints one diagnostic, a
 * `node --test` test whose TAP output names the test, and a `node --test` hook that fails and
 * cancels two tests. All sit outside `node --test` discovery, so the brief's own test check never
 * runs them; only the reviewer's chosen command does.
 */
const REDS = [
  {
    kind: 'a script diagnostic',
    file: 'legacy/report-check.mjs',
    command: 'node legacy/report-check.mjs',
    key: SCRIPT_RED_KEY,
    source: `console.error(${JSON.stringify(SCRIPT_RED_KEY)});
process.exitCode = 1;
`,
  },
  {
    kind: 'a node --test test',
    file: 'legacy/report-suite.mjs',
    command: 'node --test --test-reporter=tap legacy/report-suite.mjs',
    key: 'legacy/report-suite.mjs::legacy report > total matches the ledger',
    source: `import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

describe('legacy report', () => {
  it('total matches the ledger', () => {
    assert.equal(1 + 1, 3);
  });
});
`,
  },
  {
    kind: 'a node --test hook that cancels its tests',
    file: 'legacy/report-hooked.mjs',
    command: 'node --test --test-reporter=tap legacy/report-hooked.mjs',
    key: 'legacy/report-hooked.mjs::legacy ledger',
    source: `import { before, describe, it } from 'node:test';

describe('legacy ledger', () => {
  before(() => {
    throw new Error('ledger fixture missing');
  });
  it('opens the ledger', () => {});
  it('closes the ledger', () => {});
});
`,
  },
];

/**
 * A passing `node --test` suite of the run base that imports a module, which the run breaks so the
 * suite fails to load: a failure the run introduced, beside the pre-existing red test.
 */
const LEDGER_FILE = 'src/ledger.mjs';
const LEDGER_SOURCE = 'export const ledger = 2;\n';
const LEDGER_SUITE_FILE = 'legacy/ledger-suite.mjs';
const LEDGER_SUITE_SOURCE = `import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ledger } from '../src/ledger.mjs';

test('ledger holds the report total', () => {
  assert.equal(ledger, 2);
});
`;
const BROKEN_LEDGER = "export const ledger = 2;\nthrow new Error('ledger moved');\n";

const TOTAL_FILE = 'src/total.mjs';
const TOTAL_TEST_FILE = 'src/total.test.mjs';
const TOTAL_SOURCE = 'export const total = (a, b) => a + b;\n';
const TOTAL_TEST_SOURCE = `import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { total } from './total.mjs';

test('total adds two numbers', () => {
  assert.equal(total(1, 2), 3);
});
`;

const brief = makeTaskSpec({
  id: 'T001',
  title: 'Add the total helper',
  intent: 'Return the sum of two numbers.',
  criteria: ['C1'],
  suggestedFiles: [TOTAL_FILE, TOTAL_TEST_FILE],
  checks: [{ id: 'T001-K1', kind: 'test', value: TOTAL_TEST_FILE, required: true }],
});
const plan = makePlanProposal({
  summary: 'Add a total helper with its test.',
  decisions: [],
  criteria: [{ id: 'C1', text: 'total returns the sum.', checkIds: ['T001-K1'] }],
  tasks: [brief],
});
const reviewChecksPlan = (command: string) => ({
  commands: [{ id: 'V1', command, reason: 'The project verifies its report total with this.' }],
  declined: [],
  reason: null,
});
const verdict = passingVerdict({ kind: 'final', taskIds: [brief.id], criterionIds: ['C1'] });

type Call = { kind: string; prompt?: string };

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;

afterEach(() => {
  restorePath?.();
  vi.unstubAllEnvs();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
  resetAllStores();
});

/** The transcript rows a run's replayed log paints, one string per row. */
async function transcriptRows(ref: { projectDir: string; sessionId: string }): Promise<string[]> {
  await hydrateRun(readRunRecord(ref));
  return buildConversationRows({
    sections: groupEventsIntoSections(eventsStore.get().events),
    expandedDiffs: new Set(),
    expandedActivityBatches: new Set(),
    cols: 200,
    viewportHeight: 50,
    streaming: { taskId: null, lines: [], active: false },
  }).rows.map(rowText);
}

/** Rewrites the fixture's one commit so the run base also holds `committed`. */
function commitOnBase(projectDir: string, committed: Record<string, string>): void {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: projectDir, encoding: 'utf8' })
    .split('\0')
    .filter((path) => path !== '');
  const files: Record<string, string> = {};
  for (const path of tracked) files[path] = readFileSync(join(projectDir, path), 'utf8');
  createTestGitRepo(projectDir, { ...files, ...committed });
}

function readCalls(path: string): Call[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

/** One line of the review prompt's Pending Inputs section per red reviewer check input. */
const PENDING_INPUT = /^- \*\*(\S+)\*\* \(check · defect\)/gm;

/**
 * Starts a run whose base holds `committed`, whose reviewer chooses `command` as V1 and passes the
 * review but keeps each pending red input to verify and reports `finding`, and whose implementer
 * writes the total helper and, with `broken`, rewrites the ledger.
 */
async function startRun(opts: {
  committed: Record<string, string>;
  command: string;
  broken?: string | undefined;
  finding?: Finding | undefined;
}) {
  fixture = createStopContinueFixture(() => '');
  const target = fixture;
  commitOnBase(target.projectDir, opts.committed);
  restorePath = activateSafeCliShimPath(target.tmpDir);

  const callsPath = join(target.tmpDir, 'calls.jsonl');
  const plannerPath = join(target.tmpDir, 'planner.mjs');
  const implementerPath = join(target.tmpDir, 'implementer.mjs');
  const offlinePath = join(target.tmpDir, 'offline.mjs');
  writeFileSync(
    offlinePath,
    "globalThis.fetch = async () => { throw new Error('E2E network disabled'); };\n",
  );
  vi.stubEnv('NODE_OPTIONS', `--import=${offlinePath}`);
  writeFileSync(
    plannerPath,
    `import { appendFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
let kind;
let answer;
if (prompt.includes('# Choose the checks for this review')) {
  kind = 'review-checks';
  answer = ${JSON.stringify(reviewChecksPlan(opts.command))};
} else if (prompt.includes('# Final Implementation Review')) {
  kind = 'final-review';
  const heading = '## Pending Inputs';
  const from = prompt.indexOf(heading);
  const section = from < 0 ? '' : prompt.slice(from + heading.length).split(/^## /m)[0];
  const inputs = [...section.matchAll(new RegExp(${JSON.stringify(PENDING_INPUT.source)}, 'gm'))].map((match) => match[1]);
  answer = { ...${JSON.stringify(verdict)} };
  if (inputs.length > 0) answer.verify = inputs.map((findingId) => ({ findingId, checkIds: ['V1'] }));
  ${opts.finding === undefined ? '' : `answer.findings = [${JSON.stringify(opts.finding)}];`}
} else if (prompt.includes('# Plan the change')) {
  kind = 'plan';
  answer = ${JSON.stringify({ result: plan })};
} else {
  throw new Error('Unexpected prompt: ' + prompt);
}
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ kind, prompt }) + '\\n');
process.stdout.write(JSON.stringify(answer));
`,
  );
  writeFileSync(
    implementerPath,
    `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ kind: 'implement' }) + '\\n');
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(TOTAL_FILE)}, ${JSON.stringify(TOTAL_SOURCE)});
writeFileSync(${JSON.stringify(TOTAL_TEST_FILE)}, ${JSON.stringify(TOTAL_TEST_SOURCE)});
${opts.broken === undefined ? '' : `writeFileSync(${JSON.stringify(LEDGER_FILE)}, ${JSON.stringify(opts.broken)});`}
console.log('Implemented ${brief.id}');
`,
  );
  const config = loadConfig(target.projectDir).config;
  if (config.planner.kind !== 'shell' || config.implementer.kind !== 'agent') {
    throw new Error('Expected local shell and agent fixture runners');
  }
  writeConfig(target.projectDir, {
    ...config,
    planner: { ...config.planner, args: [plannerPath] },
    implementer: { ...config.implementer, args: [implementerPath] },
    workflow: { ...config.workflow, approve: 'none' },
    validation: {
      ...config.validation,
      endChecks: true,
      approveChecks: 'auto',
      testCommand: 'node --test',
    },
  });

  const run = await cli(target, ['start', 'total'], { timeoutMs: 120_000 });
  const sessions = readdirSync(sessionsRoot(target.projectDir));
  expect(sessions).toHaveLength(1);
  const sessionId = sessions[0];
  if (sessionId === undefined) throw new Error('Missing session');
  const ref = { projectDir: target.projectDir, sessionId };
  const replay = await readRunEvents(ref);
  expect(replay.diagnostics.skipped).toBe(0);
  return { target, run, sessionId, ref, events: replay.events, calls: readCalls(callsPath) };
}

describe('e2e: reviewer check base re-run', { timeout: 240_000 }, () => {
  it.each(REDS)(
    'marks $kind the run base already holds pre-existing and does not blame the run',
    async (red) => {
      const { target, run, sessionId, ref, events, calls } = await startRun({
        committed: { [red.file]: red.source },
        command: red.command,
      });
      expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);

      assertPlainStdout(run.stdout);
      const lines = run.stdout.split('\n').map((line) => line.trim());
      expect(lines).toContain(`task ${brief.id}: done (1 of 1 checks passed)`);
      expect(lines).toContain(`reviewer check V1: failed (${red.command})`);
      expect(lines).toContain(
        "base re-run V1: pre-existing · the failure also fails before this run's changes",
      );
      expect(lines).toContain(`base re-run V1 pre-existing: ${red.key}`);

      expect(calls.map((call) => call.kind)).toEqual([
        'plan',
        'implement',
        'review-checks',
        'final-review',
      ]);

      const planned = events.filter((event) => event.type === 'review_checks');
      expect(planned).toHaveLength(1);
      expect(planned[0]).toMatchObject({
        scope: 'final',
        status: 'planned',
        commands: [{ id: 'V1', command: red.command }],
      });

      const rows = events.flatMap((event) =>
        event.type === 'full_suite' && event.id === 'V1' ? [event] : [],
      );
      expect(rows.map((row) => ({ moment: row.moment, status: row.status }))).toEqual([
        { moment: 'pre-review', status: 'running' },
        { moment: 'pre-review', status: 'done' },
        { moment: 'base', status: 'running' },
        { moment: 'base', status: 'done' },
      ]);
      expect(rows[1]).toMatchObject({ command: red.command, passed: false });
      const baseDone = rows[3];
      expect(baseDone).toMatchObject({
        command: red.command,
        passed: false,
        newFailures: 0,
        preExisting: 1,
        preExistingKeys: [red.key],
      });
      expect(baseDone).not.toHaveProperty('notVerified');
      expect(baseDone).not.toHaveProperty('detail');
      expect(baseDone).not.toHaveProperty('newKeys');

      const baseRunning = rows[2];
      if (baseRunning === undefined) throw new Error('Missing base re-run row');
      expect(
        suiteStatusParts(baseRunning.phase, { id: 'V1', moment: 'base', command: red.command })
          .map((part) => part.text)
          .join(''),
      ).toBe(`Review · Base re-run V1 · ${red.command}`);

      const verdictPrompt = calls.find((call) => call.kind === 'final-review')?.prompt;
      expect(verdictPrompt).toContain(
        `- V1 \`${red.command}\`: failed, 0 new failure(s); 1 pre-existing (also red at the run base)`,
      );
      expect(verdictPrompt).toContain(
        `Pre-existing failures (also red at the run base):\n- ${red.key}`,
      );
      expect(verdictPrompt).toContain(
        'A failure marked pre-existing also fails at the run base: raise no finding for it.',
      );
      expect(verdictPrompt).not.toContain(`Reviewer check V1 (${red.command}) failed`);

      expect(events.some((event) => event.type === 'review_fix_started')).toBe(false);
      expect(
        events.filter((event) => event.type === 'review_completed' && event.scope === 'final'),
      ).toMatchObject([{ verdict: 'pass', findings: { blocking: 0 } }]);
      expect(events.filter((event) => event.type === 'workflow_complete')).toMatchObject([
        { review: 'passed' },
      ]);

      const state = readState(target, sessionId);
      expect(state.pendingTriage).toBeUndefined();
      expect(state.pendingRecovery).toBeUndefined();
      expect(state.tasks.map((task) => ({ id: task.id, status: task.status }))).toEqual([
        { id: brief.id, status: 'done' },
      ]);
      expect(state.reviewStatus).toBe('passed');
      expect(state.reviewChecks).toMatchObject({
        scope: 'final',
        plan: { commands: [{ id: 'V1', command: red.command }] },
      });
      expect(state.reviewChecks?.skipped).toBeUndefined();
      expect(state.review?.preExistingChecks).toEqual([
        { id: 'V1', command: red.command, keys: [red.key] },
      ]);
      expect(
        readFileSync(join(sessionDir(target.projectDir, sessionId), REVIEW_FILE), 'utf8'),
      ).toContain(
        [
          '### Pre-existing failures',
          '',
          "These reviewer checks failed at the run base too. Their failures below also fail before this run's changes, so they raise no finding.",
          '',
          `- V1 \`${red.command}\``,
          `  - ${red.key}`,
        ].join('\n'),
      );
      expect(deriveRunStatus({ state, liveness: 'not-alive' })).toEqual({
        kind: 'ready-to-apply',
        override: false,
      });

      const logged = readEvidenceLedger(ref)?.tasks.flatMap((task) => task.checks ?? []) ?? [];
      expect(logged.find((entry) => entry.id === 'V1')).toMatchObject({
        command: red.command,
        exitCode: 1,
        preExisting: [red.key],
        base: { exitCode: 1 },
      });
      expect(logged.find((entry) => entry.id === 'T001-K1')).toMatchObject({ exitCode: 0 });

      const packet = ReviewPacketSchema.parse(
        JSON.parse(readFileSync(reviewPacketJsonPath(ref), 'utf8')),
      );
      expect(packet.checks.entries.find((entry) => entry.id === 'V1')).toMatchObject({
        taskId: brief.id,
        preExisting: [red.key],
      });
      const packetMarkdown = readFileSync(reviewPacketMarkdownPath(ref), 'utf8');
      expect(packetMarkdown).toContain(`pre-existing (also red at the run base): ${red.key}`);
      // The brief's own line agrees with the Checks Log, which lists T001-K1 as passed.
      expect(packet.validation.tasks).toEqual([
        expect.objectContaining({
          taskId: brief.id,
          checks: [{ id: 'T001-K1', status: 'pass' }],
        }),
      ]);
      expect(packetMarkdown).toContain(`- ${brief.id} done: 1 of 1 checks passed`);
      expect(packetMarkdown).not.toContain('validation stages passed');

      const applied = await applyRun(target, sessionId);
      expect(applied.exitCode, applied.stderr).toBe(0);
      expect(applied.stderr).toContain('Applied 2 files to your checkout.');
      expect(readState(target, sessionId).closed?.as).toBe('applied');
      expect(readFileSync(join(target.projectDir, TOTAL_FILE), 'utf8')).toBe(TOTAL_SOURCE);
      expect(readFileSync(join(target.projectDir, TOTAL_TEST_FILE), 'utf8')).toBe(
        TOTAL_TEST_SOURCE,
      );
      expect(readFileSync(join(target.projectDir, red.file), 'utf8')).toBe(red.source);

      const transcript = await transcriptRows(ref);
      expect(transcript.some((row) => row.includes(`pre-existing · ${red.key}`))).toBe(true);

      const view = deriveSummaryView({ record: readRunRecord(ref) });
      expect(view?.review).toMatchObject({
        kind: 'written',
        preExisting: [{ id: 'V1', command: red.command, tests: [red.key] }],
      });
      const closedText = (view === null ? [] : runRows(view)).map((row) =>
        row.segments
          .map((fact) =>
            factSpans(fact)
              .map((span) => span.text)
              .join(''),
          )
          .join(' · '),
      );
      expect(closedText).toContain(`V1 pre-existing · ${red.command}`);
      expect(closedText).toContain(`  ${red.key}`);
    },
  );

  it('counts a test file the run made fail to load as new beside a pre-existing red test', async () => {
    const red = REDS[1];
    if (red === undefined) throw new Error('Missing the node --test red');
    const command = `${red.command} ${LEDGER_SUITE_FILE}`;
    const { target, run, sessionId, events, calls } = await startRun({
      committed: {
        [red.file]: red.source,
        [LEDGER_FILE]: LEDGER_SOURCE,
        [LEDGER_SUITE_FILE]: LEDGER_SUITE_SOURCE,
      },
      command,
      broken: BROKEN_LEDGER,
    });
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).not.toBe(0);
    const lines = run.stdout.split('\n').map((line) => line.trim());
    expect(lines).toContain('base re-run V1: 1\u00a0new, 1\u00a0pre-existing');
    expect(lines).toContain(`base re-run V1 new: ${LEDGER_SUITE_FILE}`);
    expect(lines).toContain(`base re-run V1 pre-existing: ${red.key}`);
    expect(lines).not.toContain(
      "base re-run V1: pre-existing · the failure also fails before this run's changes",
    );

    const base = events.find(
      (event) => event.type === 'full_suite' && event.moment === 'base' && event.status === 'done',
    );
    expect(base).toMatchObject({
      id: 'V1',
      passed: false,
      newFailures: 1,
      preExisting: 1,
      newKeys: [LEDGER_SUITE_FILE],
      preExistingKeys: [red.key],
    });

    const verdictPrompt = calls.find((call) => call.kind === 'final-review')?.prompt;
    expect(verdictPrompt).toContain(
      `- V1 \`${command}\`: failed, 1 new failure(s); 1 pre-existing (also red at the run base)`,
    );
    expect(verdictPrompt).toContain(
      `- **V1.1** (check · defect) — Reviewer check V1 (${command}) failed with new failures.`,
    );
    expect(verdictPrompt).toContain(`- ${LEDGER_SUITE_FILE}\n  Error: ledger moved`);
    expect(verdictPrompt).toContain(
      `Pre-existing failures (also red at the run base):\n- ${red.key}`,
    );

    expect(
      events.filter((event) => event.type === 'review_completed' && event.scope === 'final'),
    ).toMatchObject([
      { verdict: 'fail', findings: { blocking: 1 } },
      { verdict: 'fail', findings: { blocking: 1 } },
    ]);
    expect(events.some((event) => event.type === 'workflow_complete')).toBe(false);
    const state = readState(target, sessionId);
    expect(state.pendingTriage?.inputs.map((input) => input.id)).toEqual(['V1.1']);
    expect(state.pendingRecovery).toMatchObject({ reason: 'review-failed' });
    expect(deriveRunStatus({ state, liveness: 'not-alive' }).kind).toBe('open');
  });

  it.each(['minor', 'blocking'] as const)(
    'passes a correct change with a %s unverified finding on a check red only at the run base',
    async (severity) => {
      const red = REDS[1];
      if (red === undefined) throw new Error('Missing the node --test red');
      const finding = noteOn(red.file, severity);
      const { target, run, sessionId, ref, events } = await startRun({
        committed: { [red.file]: red.source },
        command: red.command,
        finding,
      });
      expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);

      expect(events.some((event) => event.type === 'review_fix_started')).toBe(false);
      expect(
        events.filter((event) => event.type === 'review_completed' && event.scope === 'final'),
      ).toMatchObject([{ verdict: 'pass-with-notes', findings: { blocking: 0, minor: 1 } }]);
      expect(events.filter((event) => event.type === 'workflow_complete')).toMatchObject([
        { review: 'passed' },
      ]);

      const state = readState(target, sessionId);
      expect(state.pendingRecovery).toBeUndefined();
      expect(state.review?.verification).toEqual([
        expect.objectContaining({ id: 'finding:F1', status: 'pass' }),
      ]);
      const review = readFileSync(
        join(sessionDir(target.projectDir, sessionId), REVIEW_FILE),
        'utf8',
      );
      expect(review).toContain(`**Critical**\n\nNone.\n\n**Note**\n\n- ${finding.text}\n`);
      expect(review).toContain(`### Pre-existing failures`);
      expect(deriveRunStatus({ state, liveness: 'not-alive' })).toEqual({
        kind: 'ready-to-apply',
        override: false,
      });

      const logged = readEvidenceLedger(ref)?.tasks.flatMap((task) => task.checks ?? []) ?? [];
      const v1 = logged.filter((entry) => entry.id === 'V1');
      expect(v1).toHaveLength(2);
      for (const entry of v1) expect(entry.preExisting).toEqual([red.key]);
    },
  );

  it.each([
    ['minor', 1],
    ['blocking', 2],
  ] as const)(
    'fails the review on a check that newly fails; a %s unverified finding on it makes %d blocking',
    async (severity, blocking) => {
      const red = REDS[1];
      if (red === undefined) throw new Error('Missing the node --test red');
      const finding = noteOn(red.file, severity);
      const command = `${red.command} ${LEDGER_SUITE_FILE}`;
      const { target, run, sessionId, events } = await startRun({
        committed: {
          [red.file]: red.source,
          [LEDGER_FILE]: LEDGER_SOURCE,
          [LEDGER_SUITE_FILE]: LEDGER_SUITE_SOURCE,
        },
        command,
        broken: BROKEN_LEDGER,
        finding,
      });
      expect(run.exitCode, `${run.stdout}\n${run.stderr}`).not.toBe(0);

      const completed = events.filter(
        (event) => event.type === 'review_completed' && event.scope === 'final',
      );
      expect(completed.length).toBeGreaterThan(0);
      for (const event of completed) {
        expect(event).toMatchObject({
          verdict: 'fail',
          findings: { blocking, minor: 2 - blocking },
        });
      }
      expect(events.some((event) => event.type === 'workflow_complete')).toBe(false);

      const state = readState(target, sessionId);
      expect(state.pendingRecovery).toMatchObject({ reason: 'review-failed' });
      const review = readFileSync(
        join(sessionDir(target.projectDir, sessionId), REVIEW_FILE),
        'utf8',
      );
      const [critical, note] = review.split('**Critical**')[1]?.split('**Note**') ?? [];
      expect(critical).toContain(
        `- V1.1: Reviewer check V1 (${command}) failed with new failures.`,
      );
      expect(severity === 'minor' ? note : critical).toContain(`- ${finding.text}`);
      expect(severity === 'minor' ? critical : note).not.toContain(finding.text);
    },
  );
});

/** An unverified finding on V1 that blames only a failure the run base holds too. */
function noteOn(file: string, severity: 'minor' | 'blocking'): Finding {
  return {
    id: 'F1',
    kind: 'unverified',
    severity,
    taskId: null,
    file,
    line: null,
    text: `V1 fails only on ${file}, which also fails at the run base.`,
    acceptance: null,
    checkIds: ['V1'],
    criterionId: null,
  };
}
