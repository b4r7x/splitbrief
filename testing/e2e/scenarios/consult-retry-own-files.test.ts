import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { readRunRecord } from '../../../src/core/sessions/run-record-io.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { briefRowParts } from '../../../src/features/workflow/closed/copy.js';
import { deriveSummaryView } from '../../../src/features/workflow/closed/view-model.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import {
  cli,
  createStopContinueFixture,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const RUN_TIMEOUT_MS = 150_000;
const STALE_TEXT = 'inputs changed since the brief was compiled';

const alpha = makeTaskSpec({
  id: 'T001',
  title: 'Add the alpha value',
  intent: 'Return the alpha value.',
  criteria: ['C1'],
  suggestedFiles: ['src/alpha.mjs', 'src/alpha.test.mjs'],
  checks: [{ id: 'T001-K1', kind: 'test', value: 'src/alpha.test.mjs', required: true }],
});
const plan = makePlanProposal({
  summary: 'Add one tested value.',
  decisions: [],
  criteria: [{ id: 'C1', text: 'Alpha is the string alpha.', checkIds: ['T001-K1'] }],
  tasks: [alpha],
});
const rewritten = {
  ...alpha,
  title: 'Export the alpha string',
  intent: 'Export the string alpha.',
};
const ALPHA_FILES = {
  'src/alpha.mjs': "export const alpha = 'alpha';\n",
  'src/alpha.test.mjs':
    "import { strict as assert } from 'node:assert';\nimport { alpha } from './alpha.mjs';\nassert.equal(alpha, 'alpha');\n",
};

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;

afterEach(() => {
  restorePath?.();
  vi.unstubAllEnvs();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
});

/**
 * The implementer writes the brief's two files; its first attempt reports itself blocked. The
 * planner process exits 1 on every consult, so the run halts with the files on disk. Every consult
 * logs its reason.
 */
function writeRunners(target: StopContinueFixture, callsPath: string) {
  const plannerPath = join(target.tmpDir, 'planner.mjs');
  const implementerPath = join(target.tmpDir, 'implementer.mjs');
  const passing = passingVerdict({ kind: 'final', taskIds: [alpha.id], criterionIds: ['C1'] });
  writeFileSync(
    plannerPath,
    `import { appendFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const log = (entry) => appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(entry) + '\\n');
let answer;
if (prompt.includes('# Final Implementation Review') || prompt.includes('# Task Implementation Review')) {
  answer = ${JSON.stringify(passing)};
} else if (prompt.includes('# Consult on a failing task') || prompt.includes('# Consult continued')) {
  log({ kind: 'consult', reason: prompt.match(/^#+ Reason\\s*\\n+\\s*(\\S+) —/m)?.[1] ?? 'unknown' });
  process.stderr.write('planner process stopped\\n');
  process.exit(1);
} else if (prompt.includes('# Plan the change')) {
  answer = ${JSON.stringify({ result: plan })};
} else {
  throw new Error('Unexpected prompt: ' + prompt);
}
process.stdout.write(JSON.stringify(answer));
`,
  );
  writeFileSync(
    implementerPath,
    `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const calls = readFileSync(${JSON.stringify(callsPath)}, 'utf8');
const attempt = calls.split('\\n').filter((line) => line.includes('"kind":"implement"')).length;
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ kind: 'implement', prompt }) + '\\n');
for (const [file, source] of Object.entries(${JSON.stringify(ALPHA_FILES)})) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
}
// Each attempt marks its own change, so a retry over the first attempt's files still changes one.
appendFileSync('src/alpha.mjs', '// attempt ' + attempt + '\\n');
console.log('Implemented T001');
console.log(JSON.stringify(attempt === 0
  ? { status: 'blocked', question: 'Which module should export alpha?', filesNeeded: [] }
  : {
      status: 'done',
      filesChanged: ${JSON.stringify(Object.keys(ALPHA_FILES))},
      touchedNotSuggested: [],
      notes: null,
      decisions: [],
    }));
`,
  );
  writeFileSync(callsPath, '');
  const config = loadConfig(target.projectDir).config;
  if (config.planner.kind !== 'shell' || config.implementer.kind !== 'agent') {
    throw new Error('Expected local shell and agent fixture runners');
  }
  writeConfig(target.projectDir, {
    ...config,
    planner: { ...config.planner, args: [plannerPath] },
    implementer: { ...config.implementer, args: [implementerPath] },
    validation: { ...config.validation, testCommand: 'node --test' },
    workflow: { ...config.workflow, approve: 'none' },
  });
}

/**
 * The implementer creates the brief's two files with a value the test rejects until its brief is the
 * rewritten one. The planner answers the consult on the failing brief with a rewrite that keeps its
 * files.
 */
function writeRewriteRunners(target: StopContinueFixture, callsPath: string) {
  const plannerPath = join(target.tmpDir, 'planner.mjs');
  const implementerPath = join(target.tmpDir, 'implementer.mjs');
  const passing = passingVerdict({ kind: 'final', taskIds: [alpha.id], criterionIds: ['C1'] });
  const rewrite = {
    answer: {
      diagnosis: 'The brief does not say which value alpha holds.',
      action: 'rewrite-task',
      task: rewritten,
    },
  };
  writeFileSync(
    plannerPath,
    `import { appendFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
let answer;
if (prompt.includes('# Final Implementation Review') || prompt.includes('# Task Implementation Review')) {
  answer = ${JSON.stringify(passing)};
} else if (prompt.includes('# Consult on a failing task') || prompt.includes('# Consult continued')) {
  appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ kind: 'consult' }) + '\\n');
  answer = ${JSON.stringify(rewrite)};
} else if (prompt.includes('# Plan the change')) {
  answer = ${JSON.stringify({ result: plan })};
} else {
  throw new Error('Unexpected prompt: ' + prompt);
}
process.stdout.write(JSON.stringify(answer));
`,
  );
  writeFileSync(
    implementerPath,
    `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const title = prompt.match(/^## Task: (.+)$/m)?.[1];
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ kind: 'implement', title }) + '\\n');
mkdirSync('src', { recursive: true });
const value = title === ${JSON.stringify(rewritten.title)} ? 'alpha' : 'not alpha';
writeFileSync('src/alpha.mjs', 'export const alpha = ' + JSON.stringify(value) + ';\\n');
writeFileSync('src/alpha.test.mjs', ${JSON.stringify(ALPHA_FILES['src/alpha.test.mjs'])});
console.log('Implemented T001');
`,
  );
  writeFileSync(callsPath, '');
  const config = loadConfig(target.projectDir).config;
  if (config.planner.kind !== 'shell' || config.implementer.kind !== 'agent') {
    throw new Error('Expected local shell and agent fixture runners');
  }
  writeConfig(target.projectDir, {
    ...config,
    planner: { ...config.planner, args: [plannerPath] },
    implementer: { ...config.implementer, args: [implementerPath] },
    validation: { ...config.validation, testCommand: 'node --test' },
    workflow: { ...config.workflow, review: 'task', approve: 'none' },
  });
}

const implementationChild = makeTaskSpec({
  id: 'T002',
  title: 'Write the alpha value',
  intent: 'Export the string alpha.',
  criteria: ['C1'],
  suggestedFiles: ['src/alpha.mjs'],
  checks: [],
});
const testChild = makeTaskSpec({
  id: 'T003',
  title: 'Test the alpha value',
  intent: 'Check that alpha is the string alpha.',
  criteria: ['C1'],
  suggestedFiles: ['src/alpha.test.mjs'],
  checks: alpha.checks,
  dependsOn: ['T002'],
});

/**
 * The planner plans `planned` and answers the consult on the failing brief with a split into
 * `children`; each review passes every id its prompt lists.
 */
function writeSplitPlanner(
  plannerPath: string,
  callsPath: string,
  planned: typeof plan,
  children: (typeof alpha)[],
) {
  const split = {
    answer: {
      diagnosis: 'The brief mixes two changes.',
      action: 'split-task',
      tasks: children,
    },
  };
  writeFileSync(
    plannerPath,
    `import { appendFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const ids = (label) => (prompt.match(new RegExp('^' + label + ' (.+)$', 'm'))?.[1] ?? 'none')
  .split(',').map((id) => id.trim()).filter((id) => id !== '' && id !== 'none');
let answer;
if (prompt.includes('# Final Implementation Review') || prompt.includes('# Task Implementation Review')) {
  answer = {
    tasks: ids('Task ids:').map((id) => ({ id, plan: 'met', note: '' })),
    criteria: ids('Criterion ids:').map((id) => ({ id, status: 'pass', evidence: '' })),
    findings: [], fixTasks: [], rejected: [], verify: [], ask: null,
  };
} else if (prompt.includes('# Consult on a failing task') || prompt.includes('# Consult continued')) {
  appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ kind: 'consult' }) + '\\n');
  answer = ${JSON.stringify(split)};
} else if (prompt.includes('# Plan the change')) {
  answer = ${JSON.stringify({ result: planned })};
} else {
  throw new Error('Unexpected prompt: ' + prompt);
}
process.stdout.write(JSON.stringify(answer));
`,
  );
}

/** The run plans with the split planner, checks with `node --test` and reviews each brief. */
function writeSplitConfig(
  target: StopContinueFixture,
  plannerPath: string,
  implementer: { kind: 'agent' | 'shell'; path: string },
) {
  const config = loadConfig(target.projectDir).config;
  if (config.planner.kind !== 'shell' || config.implementer.kind !== 'agent') {
    throw new Error('Expected local shell and agent fixture runners');
  }
  writeConfig(target.projectDir, {
    ...config,
    planner: { ...config.planner, args: [plannerPath] },
    implementer: { ...config.implementer, kind: implementer.kind, args: [implementer.path] },
    validation: { ...config.validation, testCommand: 'node --test' },
    workflow: { ...config.workflow, review: 'task', approve: 'none' },
  });
}

/**
 * The implementer creates the brief's two files with a value the test rejects. The planner answers
 * the consult on the failing brief with a split into an implementation child and a test child.
 */
function writeSplitRunners(target: StopContinueFixture, callsPath: string) {
  const plannerPath = join(target.tmpDir, 'planner.mjs');
  const implementerPath = join(target.tmpDir, 'implementer.mjs');
  writeSplitPlanner(plannerPath, callsPath, plan, [implementationChild, testChild]);
  writeFileSync(
    implementerPath,
    `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const title = prompt.match(/^## Task: (.+)$/m)?.[1];
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ kind: 'implement', title }) + '\\n');
mkdirSync('src', { recursive: true });
if (title === ${JSON.stringify(implementationChild.title)}) {
  writeFileSync('src/alpha.mjs', ${JSON.stringify(ALPHA_FILES['src/alpha.mjs'])});
} else if (title === ${JSON.stringify(testChild.title)}) {
  writeFileSync('src/alpha.test.mjs', ${JSON.stringify(`${ALPHA_FILES['src/alpha.test.mjs']}// alpha is checked\n`)});
} else {
  writeFileSync('src/alpha.mjs', "export const alpha = 'not alpha';\\n");
  writeFileSync('src/alpha.test.mjs', ${JSON.stringify(ALPHA_FILES['src/alpha.test.mjs'])});
}
console.log('Implemented ' + title);
`,
  );
  writeFileSync(callsPath, '');
  writeSplitConfig(target, plannerPath, { kind: 'agent', path: implementerPath });
}

const CALC_LINES = {
  add: 'export const add = (a, b) => a + b;',
  sub: 'export const sub = (a, b) => a - b;',
};
const ADD_BLOCK = [
  CALC_LINES.add,
  'export const inc = (a) => add(a, 1);',
  'export const dec = (a) => add(a, -1);',
  'export const twice = (a) => add(a, a);',
  'export const add3 = (a, b, c) => add(add(a, b), c);',
].join('\n');
const CALC_TESTS = {
  'test/calc-add.test.mjs':
    "import { strict as assert } from 'node:assert';\nimport { add } from '../src/calc.mjs';\nassert.equal(add(2, 1), 3);\n",
  'test/calc-sub.test.mjs':
    "import { strict as assert } from 'node:assert';\nimport { sub } from '../src/calc.mjs';\nassert.equal(sub(2, 1), 1);\n",
};
const addCheck = {
  id: 'T001-K1',
  kind: 'cmd' as const,
  value: 'node --test test/calc-add.test.mjs',
  required: true,
};
const subCheck = {
  id: 'T001-K2',
  kind: 'cmd' as const,
  value: 'node --test test/calc-sub.test.mjs',
  required: true,
};
const calc = makeTaskSpec({
  id: 'T001',
  title: 'Add the calc functions',
  intent: 'Export add and sub.',
  criteria: ['C1'],
  suggestedFiles: ['src/calc.mjs'],
  checks: [addCheck, subCheck],
});
const calcPlan = makePlanProposal({
  summary: 'Add two tested functions.',
  decisions: [],
  criteria: [{ id: 'C1', text: 'add and sub compute.', checkIds: ['T001-K1', 'T001-K2'] }],
  tasks: [calc],
});
const addChild = makeTaskSpec({
  id: 'T002',
  title: 'Write the add function',
  intent: 'Export add.',
  criteria: ['C1'],
  suggestedFiles: ['src/calc.mjs'],
  checks: [addCheck],
});
const subChild = makeTaskSpec({
  id: 'T003',
  title: 'Write the sub function',
  intent: 'Export sub.',
  criteria: ['C1'],
  suggestedFiles: ['src/calc.mjs'],
  checks: [subCheck],
  dependsOn: ['T002'],
});

/**
 * A `shell` implementer answers with the anchor's whole new text, as a model does: the code its
 * prompt shows, then its own lines. The brief it was split from writes a value the tests reject.
 * With `subOwnLinesFirst`, the sub child's first answer holds only its own line, as a weak model's
 * does, and its retry answers with the whole file.
 */
function writeShellSplitRunners(
  target: StopContinueFixture,
  callsPath: string,
  answers: { add: string; subOwnLinesFirst: boolean } = {
    add: CALC_LINES.add,
    subOwnLinesFirst: false,
  },
) {
  const plannerPath = join(target.tmpDir, 'planner.mjs');
  const implementerPath = join(target.tmpDir, 'implementer.mjs');
  writeSplitPlanner(plannerPath, callsPath, calcPlan, [addChild, subChild]);
  writeFileSync(
    implementerPath,
    `import { appendFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const title = prompt.match(/^## Task: (.+)$/m)?.[1];
const current = prompt.match(/^### Current Code\\n([\\s\\S]*?)(?=\\n+#{2,4} )/m)?.[1]?.trimEnd();
const retry = prompt.includes('Error from previous attempt:');
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ kind: 'implement', title, retry, current: current ?? null }) + '\\n');
const own = title === ${JSON.stringify(addChild.title)} ? ${JSON.stringify(answers.add)}
  : title === ${JSON.stringify(subChild.title)} ? ${JSON.stringify(CALC_LINES.sub)}
  : 'export const nothing = 0;';
const ownLinesOnly = ${answers.subOwnLinesFirst} && title === ${JSON.stringify(subChild.title)} && !retry;
process.stdout.write((current && !ownLinesOnly ? current + '\\n' : '') + own + '\\n');
`,
  );
  for (const [file, source] of Object.entries(CALC_TESTS)) {
    mkdirSync(join(target.projectDir, dirname(file)), { recursive: true });
    writeFileSync(join(target.projectDir, file), source);
  }
  writeFileSync(callsPath, '');
  writeSplitConfig(target, plannerPath, { kind: 'shell', path: implementerPath });
}

function readCalls(callsPath: string): {
  kind: string;
  reason?: string;
  prompt?: string;
  title?: string;
  retry?: boolean;
  current?: string | null;
}[] {
  return readFileSync(callsPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

describe('e2e: Try again on a brief that wrote its own files', { timeout: 360_000 }, () => {
  it('restarts the brief without a stale consult and keeps it creating its files', async () => {
    fixture = createStopContinueFixture(() => '', { isolation: 'none' });
    const target = fixture;
    restorePath = activateSafeCliShimPath(target.tmpDir);
    const offlinePath = join(target.tmpDir, 'offline.mjs');
    writeFileSync(
      offlinePath,
      "globalThis.fetch = async () => { throw new Error('E2E network disabled'); };\n",
    );
    vi.stubEnv('NODE_OPTIONS', `--import=${offlinePath}`);
    const callsPath = join(target.tmpDir, 'calls.jsonl');
    writeRunners(target, callsPath);

    const halted = await cli(target, ['start', 'smoke'], { timeoutMs: RUN_TIMEOUT_MS });
    expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);
    const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
    if (sessionId === undefined) throw new Error('Missing session');
    const haltState = readState(target, sessionId);
    expect(haltState.pendingRecovery).toMatchObject({
      reason: 'planner-call-failed',
      taskId: 'T001',
    });
    const consultsAtHalt = haltState.lineages?.T001?.consults;

    const continued = await cli(target, ['continue', sessionId, '--action', 'retry'], {
      timeoutMs: RUN_TIMEOUT_MS,
    });
    expect(continued.exitCode, `${continued.stdout}\n${continued.stderr}`).toBe(0);

    const calls = readCalls(callsPath);
    expect(calls.filter((call) => call.kind === 'consult').map((call) => call.reason)).toEqual([
      'blocked',
    ]);
    const builds = calls.filter((call) => call.kind === 'implement');
    expect(builds).toHaveLength(2);
    expect(builds[1]?.prompt).not.toContain(STALE_TEXT);

    const state = readState(target, sessionId);
    expect(state.phase).toBe('complete');
    expect(state.lineages?.T001?.consults).toBe(consultsAtHalt);
    expect(state.tasks[0]?.action).toBe('create');
  });
});

describe('e2e: a consult rewrite of a brief that created its files', { timeout: 360_000 }, () => {
  it('keeps the rewritten brief creating its file, also in the closed Briefs row', async () => {
    fixture = createStopContinueFixture(() => '', { isolation: 'none' });
    const target = fixture;
    restorePath = activateSafeCliShimPath(target.tmpDir);
    const offlinePath = join(target.tmpDir, 'offline.mjs');
    writeFileSync(
      offlinePath,
      "globalThis.fetch = async () => { throw new Error('E2E network disabled'); };\n",
    );
    vi.stubEnv('NODE_OPTIONS', `--import=${offlinePath}`);
    const callsPath = join(target.tmpDir, 'calls.jsonl');
    writeRewriteRunners(target, callsPath);

    const run = await cli(target, ['start', 'smoke'], { timeoutMs: RUN_TIMEOUT_MS });
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);

    const calls = readCalls(callsPath);
    expect(calls.filter((call) => call.kind === 'consult')).toHaveLength(1);
    const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
    if (sessionId === undefined) throw new Error('Missing session');
    const state = readState(target, sessionId);
    expect(state.phase).toBe('complete');
    expect(state.tasks.map((task) => [task.title, task.action])).toEqual([
      [rewritten.title, 'create'],
    ]);

    const ref = { projectDir: target.projectDir, sessionId };
    const { events } = await readRunEvents(ref);
    const replaced = events.findIndex((event) => event.type === 'task_replaced');
    expect(replaced).toBeGreaterThan(-1);
    expect(events.slice(replaced).find((event) => event.type === 'task_started')).toMatchObject({
      taskId: 'T001',
      title: rewritten.title,
      action: 'create',
    });

    const view = deriveSummaryView({ record: readRunRecord(ref) });
    if (view === null) throw new Error('the finished run has no closed view');
    expect(view.briefs.rows.map((row) => briefRowParts({ row }))).toMatchObject([
      { id: 'T001', title: rewritten.title, file: 'src/alpha.mjs', fileNote: '(create)' },
    ]);
  });
});

describe('e2e: a consult split of a brief that created its files', { timeout: 360_000 }, () => {
  it('keeps both children creating the files their parent created, also in the closed Briefs rows', async () => {
    fixture = createStopContinueFixture(() => '', { isolation: 'none' });
    const target = fixture;
    restorePath = activateSafeCliShimPath(target.tmpDir);
    const offlinePath = join(target.tmpDir, 'offline.mjs');
    writeFileSync(
      offlinePath,
      "globalThis.fetch = async () => { throw new Error('E2E network disabled'); };\n",
    );
    vi.stubEnv('NODE_OPTIONS', `--import=${offlinePath}`);
    const callsPath = join(target.tmpDir, 'calls.jsonl');
    writeSplitRunners(target, callsPath);

    const run = await cli(target, ['start', 'smoke'], { timeoutMs: RUN_TIMEOUT_MS });
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);

    expect(readCalls(callsPath).filter((call) => call.kind === 'consult')).toHaveLength(1);
    const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
    if (sessionId === undefined) throw new Error('Missing session');
    const state = readState(target, sessionId);
    expect(state.phase).toBe('complete');
    expect(state.tasks.map((task) => [task.title, task.action])).toEqual([
      [implementationChild.title, 'create'],
      [testChild.title, 'create'],
    ]);

    const view = deriveSummaryView({
      record: readRunRecord({ projectDir: target.projectDir, sessionId }),
    });
    if (view === null) throw new Error('the finished run has no closed view');
    expect(view.briefs.rows.map((row) => briefRowParts({ row }))).toMatchObject([
      { title: implementationChild.title, file: 'src/alpha.mjs', fileNote: '(create)' },
      { title: testChild.title, file: 'src/alpha.test.mjs', fileNote: '(create)' },
    ]);
  });
});

describe('e2e: a consult split of a brief whose seat answers with whole files', {
  timeout: 360_000,
}, () => {
  it('shows the second child the code the first child wrote, so both changes land', async () => {
    fixture = createStopContinueFixture(() => '', { isolation: 'none' });
    const target = fixture;
    restorePath = activateSafeCliShimPath(target.tmpDir);
    const offlinePath = join(target.tmpDir, 'offline.mjs');
    writeFileSync(
      offlinePath,
      "globalThis.fetch = async () => { throw new Error('E2E network disabled'); };\n",
    );
    vi.stubEnv('NODE_OPTIONS', `--import=${offlinePath}`);
    const callsPath = join(target.tmpDir, 'calls.jsonl');
    writeShellSplitRunners(target, callsPath);

    const run = await cli(target, ['start', 'smoke'], { timeoutMs: RUN_TIMEOUT_MS });
    const calls = readCalls(callsPath);
    const subBuild = calls.find(
      (call) => call.kind === 'implement' && call.title === subChild.title,
    );
    expect(subBuild?.current ?? 'no current code').toContain(CALC_LINES.add);
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(calls.filter((call) => call.kind === 'consult')).toHaveLength(1);
    const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
    if (sessionId === undefined) throw new Error('Missing session');
    const state = readState(target, sessionId);
    expect(state.phase).toBe('complete');
    expect(state.tasks.map((task) => [task.title, task.action])).toEqual([
      [addChild.title, 'create'],
      [subChild.title, 'create'],
    ]);
    const written = readFileSync(join(target.projectDir, 'src/calc.mjs'), 'utf8');
    expect(written).toContain(CALC_LINES.add);
    expect(written).toContain(CALC_LINES.sub);
  });

  it('keeps the code of the first child when the second child answers with only its own line', async () => {
    fixture = createStopContinueFixture(() => '', { isolation: 'none' });
    const target = fixture;
    restorePath = activateSafeCliShimPath(target.tmpDir);
    const offlinePath = join(target.tmpDir, 'offline.mjs');
    writeFileSync(
      offlinePath,
      "globalThis.fetch = async () => { throw new Error('E2E network disabled'); };\n",
    );
    vi.stubEnv('NODE_OPTIONS', `--import=${offlinePath}`);
    const callsPath = join(target.tmpDir, 'calls.jsonl');
    writeShellSplitRunners(target, callsPath, { add: ADD_BLOCK, subOwnLinesFirst: true });

    const run = await cli(target, ['start', 'smoke'], { timeoutMs: RUN_TIMEOUT_MS });
    const written = readFileSync(join(target.projectDir, 'src/calc.mjs'), 'utf8');
    expect(written).toContain(ADD_BLOCK);
    expect(written).toContain(CALC_LINES.sub);
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
    const subBuilds = readCalls(callsPath).filter(
      (call) => call.kind === 'implement' && call.title === subChild.title,
    );
    expect(subBuilds.map((call) => call.retry)).toEqual([false, true]);
    const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
    if (sessionId === undefined) throw new Error('Missing session');
    const state = readState(target, sessionId);
    expect(state.phase).toBe('complete');
    expect(state.tasks.map((task) => [task.title, task.action])).toEqual([
      [addChild.title, 'create'],
      [subChild.title, 'create'],
    ]);
  });
});
