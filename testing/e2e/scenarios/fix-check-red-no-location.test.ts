import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import type { ConsultAnswer } from '../../../src/core/schemas/consult.js';
import type { ReviewAnswer } from '../../../src/core/schemas/review.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { resetWorkflow } from '../../../src/stores/workflow/actions/reset.js';
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
import { transcriptText } from '../helpers/transcript-text.js';

const TEST_FILE = 'src/alpha.test.mjs';
const SCENARIO = 'greet-card';
// The K5-R14 red of the render check the fix brief re-runs for its finding: it names no file:line.
const RENDER_RED =
  'tui-shots: failed\nfailures: 2\n\nError: greet-card 80x24: checkpoint-capture-failed: the frame never settled';

const alpha = makeTaskSpec({
  id: 'T001',
  title: 'Add the alpha values',
  intent: 'Export alpha and its upper-case form loud.',
  criteria: ['C1'],
  suggestedFiles: ['src/alpha.mjs', TEST_FILE],
  checks: [
    { id: 'T001-K1', kind: 'test', value: TEST_FILE },
    { id: 'T001-R1', kind: 'render', value: SCENARIO },
  ],
});
const fix = makeTaskSpec({
  id: 'T002',
  title: 'Make loud the upper-case alpha',
  intent: 'Export loud as the upper-case alpha value.',
  criteria: ['C1'],
  suggestedFiles: ['src/alpha.mjs'],
  checks: [],
});
const plan = makePlanProposal({
  summary: 'Add the alpha values.',
  decisions: [],
  criteria: [{ id: 'C1', text: 'Alpha is alpha and loud is ALPHA.', checkIds: ['T001-K1'] }],
  tasks: [alpha],
});
const finding: ReviewAnswer['findings'][number] = {
  id: 'F1',
  kind: 'defect',
  severity: 'blocking',
  taskId: alpha.id,
  criterionId: 'C1',
  file: 'src/alpha.mjs',
  line: null,
  text: 'loud is not the upper-case alpha.',
  acceptance: 'loud is ALPHA.',
  checkIds: ['T001-R1'],
};
const consult: ConsultAnswer = {
  answer: {
    diagnosis: 'The render service was down; the files are right.',
    action: 'verify',
    checkIds: ['T001-K1', 'T001-R1'],
    reason: 'The render passes once its service is up.',
  },
};

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;

afterEach(() => {
  resetWorkflow();
  restorePath?.();
  vi.unstubAllEnvs();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
});

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/**
 * The final review fails until the fix task T002 exists, and its finding names T001's render
 * check. The fix brief T002 re-runs that render check, which fails after the review with output
 * that names no file:line until the consult brings the render service up and answers `verify`.
 */
function plannerScript(callsPath: string, servicePath: string, reviewedPath: string): string {
  const passing = passingVerdict({ kind: 'final', taskIds: [], criterionIds: [] });
  return `import { appendFileSync, writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
let kind;
let answer;
if (prompt.includes('# Final Implementation Review')) {
  kind = 'final-review';
  const ids = (label) => prompt.match(new RegExp('^' + label + ' (.+)$', 'm'))[1].split(',').map((id) => id.trim());
  const taskIds = ids('Task ids:');
  const fails = !taskIds.includes('T002');
  answer = {
    ...${JSON.stringify(passing)},
    tasks: taskIds.map((id) => ({ id, plan: fails ? 'partial' : 'met', note: '' })),
    criteria: ids('Criterion ids:').map((id) => ({ id, status: fails ? 'fail' : 'pass', evidence: '' })),
  };
  if (fails) {
    writeFileSync(${JSON.stringify(reviewedPath)}, 'reviewed\\n');
    answer.findings = [${JSON.stringify(finding)}];
    answer.fixTasks = [{ ...${JSON.stringify(fix)}, findingIds: ['F1'] }];
  }
} else if (prompt.includes('# Consult on a failing task') || prompt.includes('# Consult continued')) {
  kind = 'consult';
  writeFileSync(${JSON.stringify(servicePath)}, 'up\\n');
  answer = ${JSON.stringify(consult)};
} else if (prompt.includes('# Plan the change')) {
  kind = 'plan';
  answer = ${JSON.stringify({ result: plan })};
} else {
  throw new Error('Unexpected prompt: ' + prompt);
}
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ kind }) + '\\n');
process.stdout.write(JSON.stringify(answer));
`;
}

function implementerScript(): string {
  const writes = {
    [alpha.title]: {
      'src/alpha.mjs': "export const alpha = 'alpha';\nexport const loud = 'alpha';\n",
      [TEST_FILE]:
        "import { strict as assert } from 'node:assert';\nimport { alpha } from './alpha.mjs';\nassert.equal(alpha, 'alpha');\n",
    },
    [fix.title]: {
      'src/alpha.mjs': "export const alpha = 'alpha';\nexport const loud = 'ALPHA';\n",
    },
  };
  return `import { mkdirSync, writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const title = prompt.match(/^## Task: (.+)$/m)?.[1];
const files = ${JSON.stringify(writes)}[title];
if (!files) throw new Error('Unexpected brief: ' + prompt);
mkdirSync('src', { recursive: true });
for (const [file, source] of Object.entries(files)) writeFileSync(file, source);
console.log('Implemented ' + title);
`;
}

function renderScript(servicePath: string, reviewedPath: string): string {
  return `import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [, , , out] = process.argv;
if (existsSync(${JSON.stringify(reviewedPath)}) && !existsSync(${JSON.stringify(servicePath)})) {
  console.error(${JSON.stringify(RENDER_RED)});
  process.exit(1);
}
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'frame.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
`;
}

describe('e2e: a fix brief check that fails with output naming no file:line', {
  timeout: 300_000,
}, () => {
  it('shows the failed render row of the fix brief before the consult row', async () => {
    fixture = createStopContinueFixture(() => '', { isolation: 'none' });
    const target = fixture;
    restorePath = activateSafeCliShimPath(target.tmpDir);
    writeFileSync(
      join(target.projectDir, 'package.json'),
      `${JSON.stringify({ name: 'alpha', private: true, scripts: { test: 'node --test' } })}\n`,
    );
    git(target.projectDir, ['add', 'package.json']);
    git(target.projectDir, ['commit', '--quiet', '-m', 'add the project test script']);
    // Each render writes under .test-artifacts/; unignored, it would change the candidate.
    writeFileSync(join(target.projectDir, '.git', 'info', 'exclude'), '.test-artifacts/\n');
    const callsPath = join(target.tmpDir, 'calls.jsonl');
    const servicePath = join(target.tmpDir, 'render-service.flag');
    const reviewedPath = join(target.tmpDir, 'reviewed.flag');
    const plannerPath = join(target.tmpDir, 'planner.mjs');
    const implementerPath = join(target.tmpDir, 'implementer.mjs');
    const renderPath = join(target.tmpDir, 'render.mjs');
    const offlinePath = join(target.tmpDir, 'offline.mjs');
    writeFileSync(
      offlinePath,
      "globalThis.fetch = async () => { throw new Error('E2E network disabled'); };\n",
    );
    vi.stubEnv('NODE_OPTIONS', `--import=${offlinePath}`);
    writeFileSync(plannerPath, plannerScript(callsPath, servicePath, reviewedPath));
    writeFileSync(implementerPath, implementerScript());
    writeFileSync(renderPath, renderScript(servicePath, reviewedPath));
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
        testCommand: undefined,
        endChecks: false,
        render: `node ${renderPath} {id} {out}`,
      },
    });

    const run = await cli(target, ['start', 'smoke'], { timeoutMs: 180_000 });

    const output = `${run.stdout}\n${run.stderr}`;
    expect(run.exitCode, output).toBe(0);
    const calls = readFileSync(callsPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { kind: string }).kind);
    expect(
      calls.filter((kind) => kind === 'consult'),
      output,
    ).toEqual(['consult']);
    const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
    if (sessionId === undefined) throw new Error('Missing session');
    expect(readState(target, sessionId).phase).toBe('complete');

    const { events } = await readRunEvents({ projectDir: target.projectDir, sessionId });
    expect(
      events.filter(
        (event) =>
          event.type === 'full_suite' &&
          event.id === 'T001-R1' &&
          event.taskId === 'T002' &&
          event.moment === 'plan' &&
          event.status === 'done' &&
          event.passed === false,
      ).length,
    ).toBeGreaterThan(0);
    const lines = transcriptText(events).split('\n');
    const red = lines.findIndex((line) => line.includes(`Render ${SCENARIO} · failed`));
    const consulted = lines.findIndex((line) => line.includes('verify T001-K1, T001-R1'));
    expect(red, lines.join('\n')).toBeGreaterThanOrEqual(0);
    expect(consulted, lines.join('\n')).toBeGreaterThan(red);
  });
});
