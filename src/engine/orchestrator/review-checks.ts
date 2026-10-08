import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveReviewerRunner } from '../../core/config/accessors/reviewer-runner.js';
import { resolveEndChecks } from '../../core/config/runtime/resolve.js';
import { readEvidenceLedger } from '../../core/evidence/ledger-storage.js';
import type { Config } from '../../core/schemas/config.js';
import {
  REVIEW_CHECKS_PLAN_JSON_SCHEMA,
  ReviewChecksPlanSchema,
  type ReviewChecksPlan,
  type TriageInput,
} from '../../core/schemas/review.js';
import {
  fixCyclesOf,
  type ReviewChecksRecord,
  type WorkflowState,
} from '../../core/schemas/workflow.js';
import { nowIso } from '../../utils/format-time.js';
import type { EventBus } from '../events/types.js';
import type { Reviewer } from '../reviewers/types.js';
import type { SeatProtocolError } from '../runners/typed-output.js';
import { workspaceReadInstructions } from '../spec/prompts/builder.js';
import { buildReviewChecksPrompt, type ProjectFileText } from '../spec/prompts/review-checks.js';
import { recordCheckRuns } from './evidence/record-checks.js';
import { publishReviewCheck, publishReviewChecksPlan } from './events.js';
import { runBaseOf, withRunBaseTree, type RunBase } from './isolation/base-tree.js';
import { CHECK_PROGRAMS } from './planning/sanitize-discovered-validation.js';
import { runReviewerCall } from './review-call.js';
import { transitionAndSave } from './state-ops.js';
import { failingFilesFromOutput, lastTaskChangingFile } from './task/file-owner.js';
import { extractFailureKeys } from './validation/extract-failure-keys.js';
import {
  planApprovesNpmScripts,
  runChecks,
  type CheckRunResult,
  type RunChecksOptions,
} from './validation/run-checks.js';
import { failingTestKey, parseFailingTests } from './validation/test-failures.js';

/** Files a seat that reads none of its own gets verbatim, so it can see how the project verifies. */
const PROJECT_FILES = [
  'package.json',
  'Makefile',
  'makefile',
  'GNUmakefile',
  'justfile',
  'Justfile',
  '.justfile',
  'pyproject.toml',
  'setup.cfg',
  'tox.ini',
  'noxfile.py',
  'Cargo.toml',
  'go.mod',
  'composer.json',
  'Gemfile',
  'Rakefile',
  'build.gradle',
  'build.gradle.kts',
  'pom.xml',
  'mix.exs',
  'deno.json',
  '.gitlab-ci.yml',
  'README.md',
];
const CI_DIR = '.github/workflows';
const REVIEW_CHECK_INPUT_ID = /^V\d+\.\d+$/;
const MAX_FILE_CHARS = 8_000;
const MAX_PROJECT_CHARS = 40_000;

const OFF_SECTION = `## Reviewer checks

End-of-run checks are off in this run's config (validation.end_checks), so SPLITBRIEF ran no reviewer check before this review. Only the plan and task checks ran, and their output is in the Checks Log. Judge only from the recorded evidence; mark a criterion unverified when no recorded evidence proves it.`;

export type ReviewChecksOptions = {
  projectDir: string;
  workspaceDir: string;
  sessionId: string;
  config: Config;
  bus: EventBus;
  state: WorkflowState;
  reviewer: Reviewer;
  scope: 'final' | 'task';
  /** The tasks a task-cadence review covers. */
  taskIds: readonly string[];
  /** The files the review covers. */
  changedFiles: readonly string[];
  signal?: AbortSignal | undefined;
};

export type ReviewChecksOutcome =
  | { kind: 'ran'; state: WorkflowState; section: string }
  | { kind: 'protocol-error'; state: WorkflowState; error: SeatProtocolError };

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function readProjectFiles(workspaceDir: string): Promise<ProjectFileText[]> {
  let ci: string[] = [];
  try {
    ci = (await readdir(join(workspaceDir, CI_DIR)))
      .filter((name) => /\.ya?ml$/.test(name))
      .sort()
      .map((name) => `${CI_DIR}/${name}`);
  } catch {
    ci = [];
  }
  // Names compare exactly: a case-insensitive filesystem would read `Makefile` again as `makefile`.
  const present = new Set(await readdir(workspaceDir));
  const files: ProjectFileText[] = [];
  let total = 0;
  for (const path of [...PROJECT_FILES.filter((name) => present.has(name)), ...ci]) {
    const text = await readText(join(workspaceDir, path));
    if (text === null) continue;
    const room = Math.min(MAX_FILE_CHARS, MAX_PROJECT_CHARS - total);
    if (room <= 0) break;
    files.push({ path, text: text.slice(0, room), trimmed: text.length > room });
    total += Math.min(text.length, room);
  }
  return files;
}

/** The failure keys of a red command: its failing tests by name, else its diagnostic lines. */
function failureKeys(run: CheckRunResult, dir: string): string[] {
  if (run.timedOut === true) return ['timed out'];
  const output = run.output.replaceAll(`${dir}/`, '');
  const tests = parseFailingTests(output);
  const keys = tests.length > 0 ? tests.map(failingTestKey) : extractFailureKeys(output);
  if (keys.length > 0) return [...new Set(keys)];
  return [
    run.exitCode === undefined ? 'failed without diagnostics' : `exited with code ${run.exitCode}`,
  ];
}

/**
 * The keys of a red command that the same command text also shows at the run base, or why the
 * re-run at the run base could not tell.
 */
async function preExistingKeys(input: {
  id: string;
  command: string;
  run: CheckRunResult;
  keys: readonly string[];
  base: RunBase;
  checkOptions: RunChecksOptions;
  notices: { bus: EventBus; phase: WorkflowState['phase'] };
}): Promise<{ keys: string[]; unavailable?: string }> {
  const startedAt = Date.now();
  publishReviewCheck(input.notices, {
    status: 'running',
    id: input.id,
    command: input.command,
    moment: 'base',
  });
  const atBase = await withRunBaseTree(input.base, async (dir) => {
    const [run] = await runChecks([input.id], {
      ...input.checkOptions,
      projectDir: dir,
      base: undefined,
      checkoutDir: undefined,
    });
    return run === undefined ? undefined : { run, keys: failureKeys(run, dir) };
  });
  if (atBase === undefined || (atBase.run.status !== 'pass' && atBase.run.status !== 'fail')) {
    publishReviewCheck(input.notices, {
      status: atBase?.run.status === 'refused' ? 'refused' : 'not-run',
      id: input.id,
      command: input.command,
      moment: 'base',
      detail: atBase?.run.output ?? `no check ${input.id}`,
    });
    return {
      keys: [],
      unavailable: `${atBase?.run.status === 'refused' ? 'refused' : 'not run'}: ${atBase?.run.output ?? `no check ${input.id}`}`,
    };
  }
  publishReviewCheck(input.notices, {
    status: 'done',
    id: input.id,
    command: input.command,
    moment: 'base',
    passed: atBase.run.status === 'pass',
    duration: Date.now() - startedAt,
  });
  if (atBase.run.status !== 'fail') return { keys: [] };
  if (input.run.timedOut === true || atBase.run.timedOut === true) {
    return {
      keys: input.run.timedOut === true && atBase.run.timedOut === true ? [...input.keys] : [],
    };
  }
  const known = new Set(atBase.keys);
  return { keys: input.keys.filter((key) => known.has(key)) };
}

function noRunBase(
  notices: { bus: EventBus; phase: WorkflowState['phase'] },
  chosen: { id: string; command: string },
): { keys: string[]; unavailable: string } {
  const detail = 'this run recorded no run base';
  publishReviewCheck(notices, {
    status: 'not-run',
    id: chosen.id,
    command: chosen.command,
    moment: 'base',
    detail,
  });
  return { keys: [], unavailable: `not run: ${detail}` };
}

/**
 * The failures of a red reviewer check split by the run base: `preExisting` are the keys the same
 * command text also shows there, `fresh` the rest. A brief gate that runs a reviewer check again
 * splits its red the same way.
 */
export async function splitAtRunBase(input: {
  run: CheckRunResult;
  command: string;
  checkOptions: RunChecksOptions;
}): Promise<{ fresh: string[]; preExisting: string[]; unavailable?: string | undefined }> {
  const { run, command, checkOptions } = input;
  const notices = { bus: checkOptions.bus, phase: checkOptions.phase };
  const keys = failureKeys(run, checkOptions.projectDir);
  const atBase =
    checkOptions.base === undefined
      ? noRunBase(notices, { id: run.checkId, command })
      : await preExistingKeys({
          id: run.checkId,
          command,
          run,
          keys,
          base: checkOptions.base,
          checkOptions,
          notices,
        });
  return {
    fresh: keys.filter((key) => !atBase.keys.includes(key)),
    preExisting: atBase.keys,
    unavailable: atBase.unavailable,
  };
}

function planLines(plan: ReviewChecksPlan): string[] {
  const lines: string[] = [];
  if (plan.commands.length === 0) {
    lines.push(`You chose no command: ${plan.reason ?? ''}`);
  }
  if (plan.declined.length > 0) {
    lines.push('', 'You declined:');
    for (const entry of plan.declined) lines.push(`- ${entry.target}: ${entry.reason}`);
  }
  return lines;
}

/**
 * The reviewer chooses the commands that verify the change; SPLITBRIEF runs them in the run
 * workspace under the command policy, re-runs a red one at the run base with the same text, and
 * stops at the first command with new failures. New failures become pending inputs; the returned
 * section tells the verdict call what ran, what did not, and why.
 */
export async function runReviewChecks(opts: ReviewChecksOptions): Promise<ReviewChecksOutcome> {
  let state = opts.state;
  const ref = { projectDir: opts.projectDir, sessionId: opts.sessionId };
  const notices = { bus: opts.bus, phase: state.phase };
  if (!resolveEndChecks(opts.config)) {
    publishReviewChecksPlan(notices, { scope: opts.scope, status: 'off' });
    return { kind: 'ran', state, section: OFF_SECTION };
  }

  const npmScriptsApproved = planApprovesNpmScripts({ config: opts.config, state });
  const readsOwnFiles = resolveReviewerRunner(opts.config).runner.kind !== 'api';
  const prompt = buildReviewChecksPrompt({
    scope: opts.scope,
    taskIds: opts.taskIds,
    changedFiles: opts.changedFiles,
    npmScriptsApproved,
    programs: CHECK_PROGRAMS,
    ...(readsOwnFiles
      ? { workspaceInstructions: workspaceReadInstructions(opts.workspaceDir) }
      : { projectFiles: await readProjectFiles(opts.workspaceDir) }),
  });
  const call = await runReviewerCall({
    reviewer: opts.reviewer,
    prompt,
    schema: ReviewChecksPlanSchema,
    jsonSchema: REVIEW_CHECKS_PLAN_JSON_SCHEMA,
    schemaName: 'review_checks',
    projectDir: opts.projectDir,
    workspaceDir: opts.workspaceDir,
    sessionId: opts.sessionId,
    bus: opts.bus,
    state,
    signal: opts.signal,
  });
  state = call.state;
  if ('error' in call.result) return { kind: 'protocol-error', state, error: call.result.error };
  const plan = call.result.value;
  const record: ReviewChecksRecord = {
    scope: opts.scope,
    cycle: fixCyclesOf(state).used,
    plan,
    at: nowIso(),
  };
  state = transitionAndSave(ref, state, { type: 'RECORD_REVIEW_CHECKS', record });
  publishReviewChecksPlan(notices, { scope: opts.scope, status: 'planned', plan });

  const base = runBaseOf(ref, state);
  const checkOptions: RunChecksOptions = {
    plan: state.plan,
    tasks: state.tasks,
    reviewChecks: record,
    base,
    projectDir: opts.workspaceDir,
    sessionId: opts.sessionId,
    checkoutDir: opts.projectDir,
    config: opts.config,
    bus: opts.bus,
    phase: state.phase,
    npmScriptsApproved,
    discoveredValidation: state.discoveredValidation,
    signal: opts.signal,
  };
  const ledger = readEvidenceLedger(ref);
  const runs: CheckRunResult[] = [];
  const inputs: TriageInput[] = [];
  const lines: string[] = [];
  let stoppedBy: string | undefined;
  for (const chosen of plan.commands) {
    const label = `${chosen.id} \`${chosen.command}\``;
    if (stoppedBy !== undefined) {
      publishReviewCheck(notices, {
        status: 'not-run',
        id: chosen.id,
        command: chosen.command,
        moment: 'pre-review',
        detail: `${stoppedBy} failed`,
      });
      lines.push(`- ${label}: not run, ${stoppedBy} failed`);
      continue;
    }
    const startedAt = Date.now();
    publishReviewCheck(notices, {
      status: 'running',
      id: chosen.id,
      command: chosen.command,
      moment: 'pre-review',
    });
    const [run] = await runChecks([chosen.id], checkOptions);
    if (run === undefined) {
      const detail = `no result for ${chosen.id}`;
      publishReviewCheck(notices, {
        status: 'not-run',
        id: chosen.id,
        command: chosen.command,
        moment: 'pre-review',
        detail,
      });
      lines.push(`- ${label}: not run, ${detail}`);
      continue;
    }
    if (run.status !== 'pass' && run.status !== 'fail') {
      publishReviewCheck(notices, {
        status: run.status === 'refused' ? 'refused' : 'not-run',
        id: chosen.id,
        command: chosen.command,
        moment: 'pre-review',
        detail: run.output,
      });
      runs.push(run);
      lines.push(`- ${label}: ${run.status === 'refused' ? 'refused' : 'not run'}, ${run.output}`);
      continue;
    }
    publishReviewCheck(notices, {
      status: 'done',
      id: chosen.id,
      command: chosen.command,
      moment: 'pre-review',
      passed: run.status === 'pass',
      duration: Date.now() - startedAt,
    });
    if (run.status === 'pass') {
      runs.push(run);
      lines.push(`- ${label}: passed`);
      continue;
    }
    const { fresh, preExisting, unavailable } = await splitAtRunBase({
      run,
      command: chosen.command,
      checkOptions,
    });
    runs.push(preExisting.length > 0 ? { ...run, preExisting } : run);
    lines.push(
      `- ${label}: failed, ${fresh.length} new failure(s)${fresh.length > 0 ? `: ${fresh.join('; ')}` : ''}${
        preExisting.length > 0
          ? `; ${preExisting.length} pre-existing (also red at the run base): ${preExisting.join('; ')}`
          : ''
      }${unavailable === undefined ? '' : `; base re-run ${unavailable}`}`,
    );
    if (fresh.length === 0) continue;
    stoppedBy = chosen.id;
    const named = failingFilesFromOutput(run.output, opts.workspaceDir);
    for (const file of named.length > 0 ? named : [null]) {
      const owner = file === null ? undefined : lastTaskChangingFile(ledger, state.tasks, file);
      inputs.push({
        id: `${chosen.id}.${inputs.length + 1}`,
        kind: 'defect',
        source: 'check',
        file,
        text: `Reviewer check ${chosen.id} (${chosen.command}) failed with new failures: ${fresh.join('; ')}. ${
          owner === undefined ? 'No task changed it.' : `Last changed by ${owner}.`
        }`,
        checkIds: [chosen.id],
        command: chosen.command,
        output: run.output,
      });
    }
  }

  const lastTask =
    opts.scope === 'task'
      ? state.tasks.filter((task) => opts.taskIds.includes(task.id)).at(-1)
      : state.tasks.at(-1);
  if (runs.length > 0) {
    await recordCheckRuns({
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      workspaceDir: opts.workspaceDir,
      state,
      task: lastTask,
      runs,
    });
  }
  // A repeated review re-runs its commands: their earlier inputs give way to this run's.
  const pending = state.pendingTriage;
  const kept = (pending?.inputs ?? []).filter((input) => !REVIEW_CHECK_INPUT_ID.test(input.id));
  if (inputs.length > 0 || kept.length !== (pending?.inputs.length ?? 0)) {
    state = transitionAndSave(ref, state, {
      type: 'QUEUE_TRIAGE',
      inputs: [...kept, ...inputs],
      ...(pending?.question !== undefined && { question: pending.question }),
    });
  }
  const section = [
    '## Reviewer checks',
    '',
    'Before this review SPLITBRIEF ran the commands you chose, in the run workspace; their output is in the Checks Log. A failure marked pre-existing also fails at the run base: raise no finding for it. Each new failure is a pending input.',
    '',
    ...lines,
    ...planLines(plan),
  ].join('\n');
  return { kind: 'ran', state, section };
}
