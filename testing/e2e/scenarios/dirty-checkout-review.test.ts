import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { reviewPacketJsonPath, sessionsRoot } from '../../../src/core/paths.js';
import type { ReviewAnswer } from '../../../src/core/schemas/review.js';
import { ReviewPacketSchema } from '../../../src/core/schemas/review-packet.js';
import { deriveRunStatus } from '../../../src/core/sessions/run-status.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import {
  applyRun,
  cli,
  createStopContinueFixture,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const PACKAGE_FILE = 'package.json';
const PACKAGE_BASE = `${JSON.stringify({ name: 'dirty', scripts: { test: 'node --test' } }, null, 2)}\n`;
/** The user's own uncommitted edit, made before the run starts. */
const PACKAGE_USER = `${JSON.stringify(
  { name: 'dirty', scripts: { test: 'node --test && node scripts/legacy-check.mjs' } },
  null,
  2,
)}\n`;
/** The user's own untracked file, made before the run starts. */
const LEGACY_FILE = 'scripts/legacy-check.mjs';
const LEGACY_SOURCE = "console.log('legacy check ok');\n";
/** A tracked file the user edited before the run, and the run edits too. */
const NOTES_FILE = 'notes.md';
const NOTES_BASE = 'base\n';
const NOTES_USER = 'base\nuser line\n';
const NOTES_RUN = 'base\nuser line\nrun line\n';

const GITIGNORE_FILE = '.gitignore';
const GITIGNORE_FIXED = 'node_modules\ndist/\n';
const IGNORE_BUILD_OUTPUT = 'Ignore the build output';

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

type Variant = Readonly<{
  /** The user edits the checkout before the run starts. */
  dirty: boolean;
  /** The run also appends a line to the file the user had already edited. */
  editsUserFile: boolean;
  /** The reviewer's first final verdict. Every later final review passes. */
  firstReview: ReviewAnswer;
}>;

function plan(variant: Variant) {
  const brief = makeTaskSpec({
    id: 'T001',
    title: 'Add the total helper',
    intent: 'Return the sum of two numbers.',
    criteria: ['C1'],
    suggestedFiles: [TOTAL_FILE, TOTAL_TEST_FILE, ...(variant.editsUserFile ? [NOTES_FILE] : [])],
    checks: [{ id: 'T001-K1', kind: 'test', value: TOTAL_TEST_FILE, required: true }],
  });
  return makePlanProposal({
    summary: 'Add a total helper with its test.',
    decisions: ['No package.json change.'],
    criteria: [{ id: 'C1', text: 'total returns the sum.', checkIds: ['T001-K1'] }],
    tasks: [brief],
  });
}

const reviewChecksPlan = {
  commands: [{ id: 'V1', command: 'node --test', reason: 'Runs the test suite.' }],
  declined: [],
  reason: null,
};
const passing = passingVerdict({ kind: 'final', taskIds: ['T001'], criterionIds: ['C1'] });
/** What the live reviewer answered when it took the user's edits for the run's own. */
const revertUserFiles: ReviewAnswer = {
  ...passing,
  findings: [
    {
      id: 'F1',
      kind: 'defect',
      severity: 'blocking',
      taskId: null,
      file: PACKAGE_FILE,
      line: null,
      text: 'The run changed the test script and added scripts/legacy-check.mjs.',
      acceptance: 'package.json and scripts/ are as they were at the base.',
      checkIds: null,
      criterionId: null,
    },
  ],
  fixTasks: [
    {
      ...makeTaskSpec({
        id: 'T002',
        title: 'Revert package.json and remove the legacy check',
        criteria: [],
        suggestedFiles: [PACKAGE_FILE, LEGACY_FILE],
      }),
      findingIds: ['F1'],
    },
  ],
};
/** A fix of the project's own .gitignore, which a clean checkout leaves to the run. */
const ignoreBuildOutput: ReviewAnswer = {
  ...passing,
  findings: [
    {
      id: 'F1',
      kind: 'defect',
      severity: 'blocking',
      taskId: null,
      file: GITIGNORE_FILE,
      line: null,
      text: 'The build output is not ignored.',
      acceptance: '.gitignore ignores dist/.',
      checkIds: null,
      criterionId: null,
    },
  ],
  fixTasks: [
    {
      ...makeTaskSpec({
        id: 'T002',
        title: IGNORE_BUILD_OUTPUT,
        criteria: [],
        suggestedFiles: [GITIGNORE_FILE],
      }),
      findingIds: ['F1'],
    },
  ],
};

type Call = { kind: string; prompt?: string };

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;

afterEach(() => {
  restorePath?.();
  vi.unstubAllEnvs();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
});

/** Commits the base files, then leaves the user's own edits uncommitted in the checkout. */
function prepareCheckout(projectDir: string, dirty: boolean): void {
  const files: Record<string, string> = {};
  for (const path of ['.gitignore', 'tools/planner.mjs', 'tools/implementer.mjs']) {
    files[path] = readFileSync(join(projectDir, path), 'utf8');
  }
  createTestGitRepo(projectDir, {
    ...files,
    [PACKAGE_FILE]: PACKAGE_BASE,
    [NOTES_FILE]: NOTES_BASE,
  });
  if (!dirty) return;
  writeFileSync(join(projectDir, PACKAGE_FILE), PACKAGE_USER);
  writeFileSync(join(projectDir, NOTES_FILE), NOTES_USER);
  mkdirSync(join(projectDir, 'scripts'));
  writeFileSync(join(projectDir, LEGACY_FILE), LEGACY_SOURCE);
}

function readCalls(path: string): Call[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

function plannerScript(callsPath: string, variant: Variant): string {
  return `import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
let call;
let answer;
if (prompt.includes('# Choose the checks for this review')) {
  call = { kind: 'review-checks', prompt };
  answer = ${JSON.stringify(reviewChecksPlan)};
} else if (prompt.includes('# Final Implementation Review') && prompt.includes('It failed validation:')) {
  call = { kind: 'final-review-repair', prompt };
  answer = ${JSON.stringify(passing)};
} else if (prompt.includes('# Final Implementation Review')) {
  const reviewed = existsSync(${JSON.stringify(callsPath)}) &&
    readFileSync(${JSON.stringify(callsPath)}, 'utf8').includes('"kind":"final-review"');
  call = { kind: 'final-review', prompt };
  const ids = (label) => (new RegExp('^' + label + ' (.+)$', 'm').exec(prompt)?.[1] ?? 'none')
    .split(',').map((id) => id.trim()).filter((id) => id !== '' && id !== 'none');
  answer = reviewed
    ? { ...${JSON.stringify(passing)},
        tasks: ids('Task ids:').map((id) => ({ id, plan: 'met', note: '' })),
        criteria: ids('Criterion ids:').map((id) => ({ id, status: 'pass', evidence: '' })) }
    : ${JSON.stringify(variant.firstReview)};
} else if (prompt.includes('# Plan the change')) {
  call = { kind: 'plan' };
  answer = ${JSON.stringify({ result: plan(variant) })};
} else {
  throw new Error('Unexpected prompt: ' + prompt);
}
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(call) + '\\n');
process.stdout.write(JSON.stringify(answer));
`;
}

function implementerScript(callsPath: string, variant: Variant): string {
  return `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ kind: 'implement' }) + '\\n');
if (prompt.includes(${JSON.stringify(IGNORE_BUILD_OUTPUT)})) {
  appendFileSync(${JSON.stringify(GITIGNORE_FILE)}, 'dist/\\n');
  console.log('Implemented T002');
  process.exit(0);
}
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(TOTAL_FILE)}, ${JSON.stringify(TOTAL_SOURCE)});
writeFileSync(${JSON.stringify(TOTAL_TEST_FILE)}, ${JSON.stringify(TOTAL_TEST_SOURCE)});
${variant.editsUserFile ? `appendFileSync(${JSON.stringify(NOTES_FILE)}, 'run line\\n');` : ''}
console.log('Implemented T001');
`;
}

async function startRun(variant: Variant) {
  fixture = createStopContinueFixture(() => '');
  const target = fixture;
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
  writeFileSync(plannerPath, plannerScript(callsPath, variant));
  writeFileSync(implementerPath, implementerScript(callsPath, variant));
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
  prepareCheckout(target.projectDir, variant.dirty);

  const run = await cli(target, ['start', 'total'], { timeoutMs: 150_000 });
  const sessions = readdirSync(sessionsRoot(target.projectDir));
  expect(sessions).toHaveLength(1);
  const sessionId = sessions[0];
  if (sessionId === undefined) throw new Error('Missing session');
  const replay = await readRunEvents({ projectDir: target.projectDir, sessionId });
  expect(replay.diagnostics.skipped).toBe(0);
  return { target, run, sessionId, events: replay.events, calls: readCalls(callsPath) };
}

/** The body of one `## <heading>` section of a prompt. */
function section(prompt: string | undefined, heading: string): string {
  const from = prompt?.indexOf(`## ${heading}\n`) ?? -1;
  if (prompt === undefined || from < 0) return '';
  return prompt.slice(from + heading.length + 4).split(/^## /m)[0] ?? '';
}

function listed(body: string): string[] {
  return [...body.matchAll(/^- (\S+)$/gm)].map((match) => match[1] ?? '');
}

describe('e2e: a run started on a dirty checkout', { timeout: 300_000 }, () => {
  it('reviews only the run changes, refuses a fix of the user files and keeps them at Apply', async () => {
    const { target, run, sessionId, events, calls } = await startRun({
      dirty: true,
      editsUserFile: false,
      firstReview: revertUserFiles,
    });
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(calls.map((call) => call.kind)).toEqual([
      'plan',
      'implement',
      'review-checks',
      'final-review',
      'final-review-repair',
    ]);

    const choice = calls[2]?.prompt;
    expect(listed(section(choice, 'Changed files'))).toEqual([TOTAL_FILE, TOTAL_TEST_FILE]);
    expect(listed(section(choice, 'Changed before this run'))).toEqual([
      NOTES_FILE,
      PACKAGE_FILE,
      LEGACY_FILE,
    ]);

    const review = calls[3]?.prompt ?? '';
    const coverage = section(review, 'Changed Files');
    expect(coverage).toContain(
      `Files already changed when this run started: ${NOTES_FILE}, ${PACKAGE_FILE}, ${LEGACY_FILE}.`,
    );
    expect(coverage).toContain('Files with uncertain attribution or later edits: none observed.');
    expect(section(review, 'Workspace Context')).toBe('');

    expect(calls[4]?.prompt).toContain(
      `Fix task T002 targets ${PACKAGE_FILE}: it was already changed when this run started, and this run did not change it.`,
    );
    expect(calls[4]?.prompt).toContain(
      `Fix task T002 targets ${LEGACY_FILE}: it was already changed when this run started, and this run did not change it.`,
    );

    expect(
      events.filter((event) => event.type === 'review_completed' && event.scope === 'final'),
    ).toMatchObject([{ verdict: 'pass' }]);
    const state = readState(target, sessionId);
    expect(state.tasks.map((task) => task.id)).toEqual(['T001']);
    expect(deriveRunStatus({ state, liveness: 'not-alive' })).toEqual({
      kind: 'ready-to-apply',
      override: false,
    });

    const applied = await applyRun(target, sessionId);
    expect(applied.exitCode, applied.stderr).toBe(0);
    expect(readState(target, sessionId).closed?.as).toBe('applied');
    expect(readFileSync(join(target.projectDir, TOTAL_FILE), 'utf8')).toBe(TOTAL_SOURCE);
    expect(readFileSync(join(target.projectDir, PACKAGE_FILE), 'utf8')).toBe(PACKAGE_USER);
    expect(readFileSync(join(target.projectDir, LEGACY_FILE), 'utf8')).toBe(LEGACY_SOURCE);
    expect(readFileSync(join(target.projectDir, NOTES_FILE), 'utf8')).toBe(NOTES_USER);

    const packet = ReviewPacketSchema.parse(
      JSON.parse(
        readFileSync(reviewPacketJsonPath({ projectDir: target.projectDir, sessionId }), 'utf8'),
      ),
    );
    expect(packet.changes.changedFiles).toEqual([TOTAL_FILE, TOTAL_TEST_FILE]);
    expect(packet.changes.provenance?.preRunFiles).toEqual([NOTES_FILE, PACKAGE_FILE, LEGACY_FILE]);
  });

  it('reviews only its own lines of a file the user had changed, and Apply keeps both', async () => {
    const { target, run, sessionId, calls } = await startRun({
      dirty: true,
      editsUserFile: true,
      firstReview: passing,
    });
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(calls.map((call) => call.kind)).toEqual([
      'plan',
      'implement',
      'review-checks',
      'final-review',
    ]);

    const choice = calls[2]?.prompt;
    expect(listed(section(choice, 'Changed files'))).toEqual([
      NOTES_FILE,
      TOTAL_FILE,
      TOTAL_TEST_FILE,
    ]);
    expect(listed(section(choice, 'Changed before this run'))).toEqual([
      NOTES_FILE,
      PACKAGE_FILE,
      LEGACY_FILE,
    ]);

    const diff = section(calls[3]?.prompt, 'Implementation Diff');
    expect(diff).toContain('+run line');
    expect(diff).not.toContain('+user line');

    const applied = await applyRun(target, sessionId);
    expect(applied.exitCode, applied.stderr).toBe(0);
    expect(readState(target, sessionId).closed?.as).toBe('applied');
    expect(readFileSync(join(target.projectDir, NOTES_FILE), 'utf8')).toBe(NOTES_RUN);
    expect(readFileSync(join(target.projectDir, PACKAGE_FILE), 'utf8')).toBe(PACKAGE_USER);
    expect(readFileSync(join(target.projectDir, LEGACY_FILE), 'utf8')).toBe(LEGACY_SOURCE);
  });

  it('on a clean checkout lists no user file and lets a fix change .gitignore', async () => {
    const { target, run, sessionId, calls } = await startRun({
      dirty: false,
      editsUserFile: false,
      firstReview: ignoreBuildOutput,
    });
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(calls.map((call) => call.kind)).toEqual([
      'plan',
      'implement',
      'review-checks',
      'final-review',
      'implement',
      'review-checks',
      'final-review',
    ]);

    const choice = calls[2]?.prompt ?? '';
    expect(listed(section(choice, 'Changed files'))).toEqual([TOTAL_FILE, TOTAL_TEST_FILE]);
    expect(choice).not.toContain('## Changed before this run');
    expect(section(calls[3]?.prompt, 'Changed Files')).toContain(
      'Files already changed when this run started: none.',
    );
    expect(listed(section(calls[5]?.prompt, 'Changed files'))).toEqual([
      GITIGNORE_FILE,
      TOTAL_FILE,
      TOTAL_TEST_FILE,
    ]);

    expect(readState(target, sessionId).tasks.map((task) => task.id)).toEqual(['T001', 'T002']);
    const applied = await applyRun(target, sessionId);
    expect(applied.exitCode, applied.stderr).toBe(0);
    expect(readFileSync(join(target.projectDir, GITIGNORE_FILE), 'utf8')).toBe(GITIGNORE_FIXED);
    expect(readFileSync(join(target.projectDir, TOTAL_FILE), 'utf8')).toBe(TOTAL_SOURCE);
  });
});
