import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { readEvidenceLedger } from '../../../src/core/evidence/ledger-storage.js';
import { sessionDir, sessionsRoot } from '../../../src/core/paths.js';
import { readRunRecord } from '../../../src/core/sessions/run-record-io.js';
import { filesRows } from '../../../src/features/workflow/closed/copy.js';
import { changedFileCount } from '../../../src/features/workflow/closed/projections.js';
import { deriveSummaryView } from '../../../src/features/workflow/closed/view-model.js';
import { resultMenuRows } from '../../../src/features/workflow/result/options.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  cli,
  createStopContinueFixture,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const RUN_TIMEOUT_MS = 150_000;

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;

afterEach(() => {
  restorePath?.();
  vi.unstubAllEnvs();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
});

/** The check passes once the planner's first consult removed the flag file. */
function flagTest(flag: string): string {
  return `import { existsSync } from 'node:fs';\nimport { strict as assert } from 'node:assert';\nimport { test } from 'node:test';\ntest('alpha', () => assert.ok(!existsSync(${JSON.stringify(flag)})));\n`;
}

/**
 * The planner plans `planned`, passes every review on the ids its prompt lists (the first one
 * answers `firstReview` when given), and answers the consults in turn; each consult removes the
 * flag. The implementer writes the files that `implementer` lists for the brief title in its
 * prompt.
 */
function writeRunners(
  target: StopContinueFixture,
  planned: ReturnType<typeof makePlanProposal>,
  consults: unknown[],
  filesByTitle: Record<string, Record<string, string>>,
  firstReview?: unknown,
) {
  const flag = join(target.tmpDir, 'flag');
  writeFileSync(flag, 'x');
  const counter = join(target.tmpDir, 'consults');
  writeFileSync(counter, '0');
  const reviewed = join(target.tmpDir, 'reviewed');
  const plannerPath = join(target.tmpDir, 'planner.mjs');
  const implementerPath = join(target.tmpDir, 'implementer.mjs');
  writeFileSync(
    plannerPath,
    `import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const ids = (label) => (prompt.match(new RegExp('^' + label + ' (.+)$', 'm'))?.[1] ?? 'none')
  .split(',').map((id) => id.trim()).filter((id) => id !== '' && id !== 'none');
let answer;
const firstReview = ${JSON.stringify(firstReview ?? null)};
if (prompt.includes('# Task Implementation Review') && firstReview !== null && !existsSync(${JSON.stringify(reviewed)})) {
  writeFileSync(${JSON.stringify(reviewed)}, 'x');
  answer = firstReview;
} else if (prompt.includes('# Final Implementation Review') || prompt.includes('# Task Implementation Review')) {
  answer = {
    tasks: ids('Task ids:').map((id) => ({ id, plan: 'met', note: '' })),
    criteria: ids('Criterion ids:').map((id) => ({ id, status: 'pass', evidence: '' })),
    findings: [], fixTasks: [], rejected: [], verify: [], ask: null,
  };
} else if (prompt.includes('# Consult on a failing task') || prompt.includes('# Consult continued')) {
  const n = Number(readFileSync(${JSON.stringify(counter)}, 'utf8'));
  writeFileSync(${JSON.stringify(counter)}, String(n + 1));
  rmSync(${JSON.stringify(flag)}, { force: true });
  const answers = ${JSON.stringify(consults)};
  answer = answers[Math.min(n, answers.length - 1)];
} else if (prompt.includes('# Plan the change')) {
  answer = ${JSON.stringify({ result: planned })};
} else {
  throw new Error('Unexpected prompt: ' + prompt);
}
process.stdout.write(JSON.stringify(answer));
`,
  );
  writeFileSync(
    implementerPath,
    `import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const title = prompt.match(/^## Task: (.+)$/m)?.[1];
const files = ${JSON.stringify(filesByTitle)}[title] ?? {};
for (const [file, source] of Object.entries(files)) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source.replace('FLAG_TEST', ${JSON.stringify(flagTest(flag))}));
}
console.log('Implemented ' + title);
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
    workflow: { ...config.workflow, review: 'task', approve: 'none' },
  });
}

function startFixture(): StopContinueFixture {
  fixture = createStopContinueFixture(() => '');
  restorePath = activateSafeCliShimPath(fixture.tmpDir);
  const offlinePath = join(fixture.tmpDir, 'offline.mjs');
  writeFileSync(
    offlinePath,
    "globalThis.fetch = async () => { throw new Error('E2E network disabled'); };\n",
  );
  vi.stubEnv('NODE_OPTIONS', `--import=${offlinePath}`);
  return fixture;
}

function patchFiles(ref: { projectDir: string; sessionId: string }): string[] {
  const patch = readFileSync(join(sessionDir(ref.projectDir, ref.sessionId), 'run.patch'), 'utf8');
  return [...patch.matchAll(/^diff --git a\/(\S+) b\//gm)]
    .flatMap((match) => match[1] ?? [])
    .sort();
}

async function runToReady(target: StopContinueFixture) {
  const run = await cli(target, ['start', 'booking'], { timeoutMs: RUN_TIMEOUT_MS });
  expect(run.exitCode, run.stderr).toBe(0);
  const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
  if (sessionId === undefined) throw new Error('the run left no session');
  const ref = { projectDir: target.projectDir, sessionId };
  expect(readState(target, sessionId).phase).toBe('complete');
  const files = changedFileCount(readRunRecord(ref).summary);
  return { ref, files };
}

function bookedFiles(ref: { projectDir: string; sessionId: string }): string[] {
  return (readEvidenceLedger(ref)?.tasks ?? []).flatMap((entry) => entry.changedFiles).sort();
}

const check = {
  id: 'T001-K1',
  kind: 'cmd' as const,
  value: 'node --test src/alpha.test.mjs',
  required: true,
};

describe('e2e: the booking of a brief the planner rewrote or split', { timeout: 400_000 }, () => {
  it('counts the earlier attempts of a rewritten brief that a verify passes with no new change', async () => {
    const target = startFixture();
    const alpha = makeTaskSpec({
      id: 'T001',
      title: 'Add the alpha value',
      intent: 'Return the alpha value.',
      criteria: ['C1'],
      suggestedFiles: ['src/alpha.mjs', 'src/alpha.test.mjs'],
      checks: [check],
    });
    const rewritten = { ...alpha, title: 'Export the alpha string', intent: 'Export alpha.' };
    const alphaFiles = {
      'src/alpha.mjs': "export const alpha = 'alpha';\n",
      'src/alpha.test.mjs': 'FLAG_TEST',
    };
    writeRunners(
      target,
      makePlanProposal({
        summary: 'Add one tested value.',
        decisions: [],
        criteria: [{ id: 'C1', text: 'Alpha is the string alpha.', checkIds: [check.id] }],
        tasks: [alpha],
      }),
      [
        { answer: { diagnosis: 'The brief is vague.', action: 'rewrite-task', task: rewritten } },
        {
          answer: {
            diagnosis: 'The code is already there.',
            action: 'verify',
            checkIds: [check.id],
            reason: 'The files are in place.',
          },
        },
      ],
      { [alpha.title]: alphaFiles, [rewritten.title]: alphaFiles },
    );

    const { ref, files } = await runToReady(target);
    const rows = resultMenuRows({ override: false, findings: [], confirming: false, files });
    const applied = await cli(target, ['continue', ref.sessionId, '--action', 'apply'], {
      timeoutMs: RUN_TIMEOUT_MS,
    });

    expect(applied.exitCode, applied.stderr).toBe(0);
    expect(applied.stderr).toContain('Applied 2 files to your checkout.');
    expect(files).toBe(2);
    expect(rows.map((row) => row.consequence)).not.toContain('close the run; it changed no files');
    expect(bookedFiles(ref)).toEqual(['src/alpha.mjs', 'src/alpha.test.mjs']);
  });

  it('agrees on one file set across Ready, the closed Files list and run.patch after a split', async () => {
    const target = startFixture();
    const parent = makeTaskSpec({
      id: 'T001',
      title: 'Add the alpha and beta values',
      intent: 'Return both values.',
      criteria: ['C1'],
      suggestedFiles: ['src/a.mjs', 'src/b.mjs'],
      checks: [check],
    });
    const first = makeTaskSpec({
      id: 'T002',
      title: 'Write the alpha value',
      intent: 'Export alpha.',
      criteria: ['C1'],
      suggestedFiles: ['src/a.mjs'],
      checks: [],
    });
    const second = makeTaskSpec({
      id: 'T003',
      title: 'Write the beta value',
      intent: 'Export beta.',
      criteria: ['C1'],
      suggestedFiles: ['src/b.mjs'],
      checks: [check],
      dependsOn: ['T002'],
    });
    writeRunners(
      target,
      makePlanProposal({
        summary: 'Add two values.',
        decisions: [],
        criteria: [{ id: 'C1', text: 'Both values exist.', checkIds: [check.id] }],
        tasks: [parent],
      }),
      [
        {
          answer: {
            diagnosis: 'The brief mixes two changes.',
            action: 'split-task',
            tasks: [first, second],
          },
        },
      ],
      {
        [parent.title]: {
          'src/a.mjs': "export const a = 'draft';\n",
          'src/b.mjs': "export const b = 'draft';\n",
          'gen/x.txt': 'generated\n',
          'src/alpha.test.mjs': 'FLAG_TEST',
        },
        [first.title]: { 'src/a.mjs': "export const a = 'alpha';\n" },
        [second.title]: { 'src/b.mjs': "export const b = 'beta';\n" },
      },
    );

    const { ref, files } = await runToReady(target);
    const ended = await cli(target, ['continue', ref.sessionId, '--action', 'end-run'], {
      timeoutMs: RUN_TIMEOUT_MS,
    });

    expect(ended.exitCode, ended.stderr).toBe(0);
    const view = deriveSummaryView({ record: readRunRecord(ref) });
    if (view === null) throw new Error('the ended run has no closed view');
    const expected = ['gen/x.txt', 'src/a.mjs', 'src/alpha.test.mjs', 'src/b.mjs'];
    expect(files).toBe(expected.length);
    expect(filesRows(view).map((row) => row.path)).toEqual(expected);
    expect(patchFiles(ref)).toEqual(expected);
    expect(bookedFiles(ref)).toEqual(expected);
  });

  it('agrees on one file set in the closed Files list and run.patch when the run ends between split children', async () => {
    const target = startFixture();
    const parent = makeTaskSpec({
      id: 'T001',
      title: 'Add the alpha and beta values',
      intent: 'Return both values.',
      criteria: ['C1'],
      suggestedFiles: ['src/a.mjs', 'src/b.mjs'],
      checks: [check],
    });
    const first = makeTaskSpec({
      id: 'T002',
      title: 'Write the alpha value',
      intent: 'Export alpha.',
      criteria: ['C1'],
      suggestedFiles: ['src/a.mjs'],
      checks: [],
    });
    const second = makeTaskSpec({
      id: 'T003',
      title: 'Write the beta value',
      intent: 'Export beta.',
      criteria: ['C1'],
      suggestedFiles: ['src/b.mjs'],
      checks: [check],
      dependsOn: ['T002'],
    });
    writeRunners(
      target,
      makePlanProposal({
        summary: 'Add two values.',
        decisions: [],
        criteria: [{ id: 'C1', text: 'Both values exist.', checkIds: [check.id] }],
        tasks: [parent],
      }),
      [
        {
          answer: {
            diagnosis: 'The brief mixes two changes.',
            action: 'split-task',
            tasks: [first, second],
          },
        },
      ],
      {
        [parent.title]: {
          'src/a.mjs': "export const a = 'draft';\n",
          'src/b.mjs': "export const b = 'draft';\n",
          'gen/x.txt': 'generated\n',
          'src/alpha.test.mjs': 'FLAG_TEST',
        },
        [first.title]: { 'src/a.mjs': "export const a = 'alpha';\n" },
        [second.title]: { 'src/b.mjs': "export const b = 'beta';\n" },
      },
      {
        tasks: [{ id: 'T002', plan: 'partial', note: 'The alpha name is open.' }],
        criteria: [],
        findings: [
          {
            id: 'F1',
            kind: 'question',
            severity: 'blocking',
            taskId: 'T002',
            file: 'src/a.mjs',
            line: null,
            text: 'The alpha value has no agreed name.',
            acceptance: null,
            checkIds: null,
            criterionId: null,
          },
        ],
        fixTasks: [],
        rejected: [],
        verify: [],
        ask: {
          question: 'Which name does the alpha value take?',
          whyOnlyUserCanAnswer: 'The name is a product choice.',
        },
      },
    );

    const run = await cli(target, ['start', 'booking'], { timeoutMs: RUN_TIMEOUT_MS });
    const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
    if (sessionId === undefined) throw new Error('the run left no session');
    const ref = { projectDir: target.projectDir, sessionId };
    const halted = readState(target, sessionId);
    expect(
      halted.tasks.map((task) => [task.id, task.status]),
      run.stderr,
    ).toEqual([
      ['T002', 'done'],
      ['T003', 'pending'],
    ]);
    const ended = await cli(target, ['continue', ref.sessionId, '--action', 'end-run'], {
      timeoutMs: RUN_TIMEOUT_MS,
    });

    expect(ended.exitCode, ended.stderr).toBe(0);
    const view = deriveSummaryView({ record: readRunRecord(ref) });
    if (view === null) throw new Error('the ended run has no closed view');
    const expected = ['gen/x.txt', 'src/a.mjs', 'src/alpha.test.mjs', 'src/b.mjs'];
    expect(filesRows(view).map((row) => row.path)).toEqual(expected);
    expect(patchFiles(ref)).toEqual(expected);
    expect(bookedFiles(ref)).toEqual(expected);
  });
});
