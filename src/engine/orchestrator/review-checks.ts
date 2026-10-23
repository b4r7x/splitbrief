import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveReviewerRunner } from '../../core/config/accessors/reviewer-runner.js';
import { resolveApproveChecks, resolveEndChecks } from '../../core/config/runtime/resolve.js';
import { readEvidenceLedger } from '../../core/evidence/ledger-storage.js';
import { judgeFixCheck, type FixCheckKeys } from '../../core/review/fix-task.js';
import type { Config } from '../../core/schemas/config.js';
import {
  MAX_REVIEW_CHECKS,
  REVIEW_CHECKS_PLAN_JSON_SCHEMA,
  ReviewChecksPlanSchema,
  type ReviewChecksPlan,
  type TriageInput,
} from '../../core/schemas/review.js';
import {
  fixCyclesOf,
  type ReviewChecksRecord,
  type ReviewRecord,
  type WorkflowState,
} from '../../core/schemas/workflow.js';
import { namesListedIn } from '../../lib/fs.js';
import { throwIfAborted } from '../../utils/abort.js';
import { nowIso } from '../../utils/format-time.js';
import type { EventBus } from '../events/types.js';
import type { Reviewer } from '../reviewers/types.js';
import type { OrchestratorCallbacks } from './types.js';
import type { SeatProtocolError } from '../runners/typed-output.js';
import { workspaceReadInstructions } from '../spec/prompts/builder.js';
import { buildReviewChecksPrompt, type ProjectFileText } from '../spec/prompts/review-checks.js';
import { recordCheckRuns } from './evidence/record-checks.js';
import { publishReviewCheck, publishReviewChecksPlan } from './events.js';
import { runBaseOf, withRunBaseTree, type RunBase } from './isolation/base-tree.js';
import { runBaseTreeError } from './isolation/errors.js';
import { runReviewerCall } from './review-call.js';
import { reviewOperatorInstructions, reviewPlanData } from './review-plan.js';
import { plannerFeature } from './run/planner-callbacks-context.js';
import { transitionAndSave } from './state-ops.js';
import { failingFilesFromKeys, fileOwnerSentence } from './task/file-owner.js';
import type { FailureKeys } from './validation/extract-failure-keys.js';
import { checkFailureText, failureKeysForFile, newFailureKeys } from './validation/failure-text.js';
import {
  planApprovesNpmScripts,
  reviewCheckList,
  runChecks,
  type CheckRunResult,
  type RunChecksOptions,
} from './validation/run-checks.js';

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
  /** The files already changed when the run started. */
  preRunFiles: readonly string[];
  signal?: AbortSignal | undefined;
  /** Asks the user to run or skip the chosen commands; a run without a screen has none. */
  onApproval?: OrchestratorCallbacks['onReviewChecksApproval'];
};

export type ReviewChecksOutcome =
  | {
      kind: 'ran';
      state: WorkflowState;
      section: string;
      discharged: string[];
      /** The chosen commands that were red at the run base too, with those failures. */
      preExistingChecks: NonNullable<ReviewRecord['preExistingChecks']>;
    }
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
  const files: ProjectFileText[] = [];
  let total = 0;
  for (const path of [...(await namesListedIn(workspaceDir, PROJECT_FILES)), ...ci]) {
    const text = await readText(join(workspaceDir, path));
    if (text === null) continue;
    const room = Math.min(MAX_FILE_CHARS, MAX_PROJECT_CHARS - total);
    if (room <= 0) break;
    files.push({ path, text: text.slice(0, room), trimmed: text.length > room });
    total += Math.min(text.length, room);
  }
  return files;
}

/** Why two reds whose keys include a placeholder do not show the same failure. */
function notVerifiedReason(workspace: FailureKeys, base: FailureKeys): string {
  if (workspace.placeholder !== undefined && workspace.placeholder === base.placeholder) {
    return `both runs ${workspace.placeholder}`;
  }
  return [
    workspace.placeholder === undefined ? null : `the workspace run ${workspace.placeholder}`,
    base.placeholder === undefined ? null : `the run base re-run ${base.placeholder}`,
  ]
    .filter((side) => side !== null)
    .join(' and ');
}

/**
 * The keys of a red command that the same command text also shows at the run base, or why the
 * re-run at the run base could not tell. A red base re-run proves a pre-existing failure only when
 * both runs name their failures: with a placeholder on either side nothing is pre-existing, and
 * `notVerified` says why. A run base that cannot be prepared leaves every key not verified, with
 * the preparation error and any cleanup error as the reason. Cleanup errors after a completed
 * re-run also leave every key not verified, with the cleanup error visible in the row detail.
 */
async function preExistingKeys(input: {
  id: string;
  command: string;
  failure: FailureKeys;
  base: RunBase;
  checkOptions: RunChecksOptions;
  notices: { bus: EventBus; phase: WorkflowState['phase'] };
}): Promise<{
  keys: string[];
  run?: CheckRunResult | undefined;
  unavailable?: string | undefined;
  notVerified?: string | undefined;
}> {
  const startedAt = Date.now();
  publishReviewCheck(input.notices, {
    status: 'running',
    id: input.id,
    command: input.command,
    moment: 'base',
  });
  let atBase: { run: CheckRunResult; incomplete: string | undefined } | undefined;
  let treeError: string | undefined;
  try {
    const completed = await withRunBaseTree(input.base, async ({ dir, incomplete }) => {
      const [run] = await runChecks([input.id], {
        ...input.checkOptions,
        projectDir: dir,
        base: undefined,
        checkoutDir: undefined,
      });
      return run === undefined ? undefined : { run, incomplete };
    });
    atBase = completed.result;
    treeError = completed.cleanupError;
  } catch (err) {
    if (!runBaseTreeError.isPreparationFailed(err)) throw err;
    treeError = err.message;
  }
  if (treeError !== undefined) {
    publishReviewCheck(input.notices, {
      status: 'done',
      id: input.id,
      command: input.command,
      moment: 'base',
      passed: false,
      detail: treeError,
      duration: Date.now() - startedAt,
      newFailures: 0,
      preExisting: 0,
      notVerified: input.failure.keys.length,
    });
    return { keys: [], notVerified: treeError };
  }
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
      run: atBase?.run,
      unavailable: `${atBase?.run.status === 'refused' ? 'refused' : 'not run'}: ${atBase?.run.output ?? `no check ${input.id}`}`,
    };
  }
  const baseFailure = atBase.run.status === 'fail' ? atBase.run.failure : undefined;
  const reason =
    baseFailure === undefined
      ? undefined
      : (atBase.incomplete ??
        (input.failure.placeholder !== undefined || baseFailure.placeholder !== undefined
          ? notVerifiedReason(input.failure, baseFailure)
          : undefined));
  const known = new Set(baseFailure?.keys);
  const keys =
    baseFailure !== undefined && reason === undefined
      ? input.failure.keys.filter((key) => known.has(key))
      : [];
  publishReviewCheck(input.notices, {
    status: 'done',
    id: input.id,
    command: input.command,
    moment: 'base',
    passed: atBase.run.status === 'pass',
    detail: reason,
    duration: Date.now() - startedAt,
    newFailures: reason === undefined ? input.failure.keys.length - keys.length : 0,
    preExisting: keys.length,
    notVerified: reason === undefined ? undefined : input.failure.keys.length,
    ...(reason === undefined && {
      newKeys: input.failure.keys.filter((key) => !known.has(key)),
      preExistingKeys: keys,
    }),
  });
  return { keys, run: atBase.run, notVerified: reason };
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
 * command text also shows there. `notVerified` says why a red that is also red at the run base is
 * not shown to be the same failure; its keys stay new.
 */
async function splitAtRunBase(input: {
  run: Extract<CheckRunResult, { status: 'fail' }>;
  command: string;
  checkOptions: RunChecksOptions;
}): Promise<{
  preExisting: string[];
  base?: CheckRunResult | undefined;
  unavailable?: string | undefined;
  notVerified?: string | undefined;
}> {
  const { run, command, checkOptions } = input;
  const notices = { bus: checkOptions.bus, phase: checkOptions.phase };
  const failure = run.failure;
  const atBase =
    checkOptions.base === undefined
      ? noRunBase(notices, { id: run.checkId, command })
      : await preExistingKeys({
          id: run.checkId,
          command,
          failure,
          base: checkOptions.base,
          checkOptions,
          notices,
        });
  return {
    preExisting: atBase.keys,
    base: 'run' in atBase ? atBase.run : undefined,
    unavailable: atBase.unavailable,
    notVerified: 'notVerified' in atBase ? atBase.notVerified : undefined,
  };
}

/** Runs a reviewer check once; only a pre-review red splits at the run base. */
export async function runReviewCheck(
  input: {
    check: { id: string; command: string };
    checkOptions: RunChecksOptions;
  } & ({ moment: 'pre-review' } | { moment: 'brief'; carried: FixCheckKeys }),
): Promise<{
  run: CheckRunResult;
  fresh: string[];
  unavailable?: string | undefined;
  notVerified?: string | undefined;
}> {
  const { moment, checkOptions } = input;
  const { id, command } = input.check;
  const notices = { bus: checkOptions.bus, phase: checkOptions.phase };
  const startedAt = Date.now();
  publishReviewCheck(notices, { status: 'running', id, command, moment });
  const [result] = await runChecks([id], checkOptions);
  const run: CheckRunResult = result ?? {
    checkId: id,
    status: 'unknown',
    output: `no result for ${id}`,
  };
  if (run.status !== 'pass' && run.status !== 'fail') {
    publishReviewCheck(notices, {
      status: run.status === 'refused' ? 'refused' : 'not-run',
      id,
      command,
      moment,
      detail: run.output,
    });
    return { run, fresh: [] };
  }
  const judged =
    input.moment === 'brief' && (run.status === 'fail' || run.status === 'pass')
      ? judgeFixCheck(input.carried, run.status === 'fail' ? run.failure : null)
      : null;
  publishReviewCheck(notices, {
    status: 'done',
    id,
    command,
    moment,
    passed: run.status === 'pass' || (judged?.left.length === 0 && judged.proven),
    duration: Date.now() - startedAt,
    ...(judged !== null && {
      own: judged.own,
      ownLeft: judged.left.length,
      others: judged.others,
      proven: judged.proven,
    }),
  });
  if (run.status !== 'fail') return { run, fresh: [] };
  if (moment === 'brief') {
    return { run, fresh: judged === null || !judged.proven ? run.failure.keys : judged.left };
  }
  const { preExisting, base, unavailable, notVerified } = await splitAtRunBase({
    run,
    command,
    checkOptions,
  });
  const split: CheckRunResult = {
    ...run,
    ...(preExisting.length > 0 && { preExisting }),
    ...(base !== undefined && {
      base: {
        output: base.output,
        ...(base.exitCode !== undefined && { exitCode: base.exitCode }),
      },
    }),
  };
  return { run: split, fresh: newFailureKeys(split), unavailable, notVerified };
}

/** Why none of the chosen commands ran, as the row, the record and the verdict call name it. */
export const REVIEW_CHECKS_SKIP_REASON = {
  user: 'Skip all was chosen on the card',
  noAnswer: 'the reviewer checks card closed without an answer',
  noScreen: 'validation.approve_checks is ask and this run has no screen to ask on',
} as const;

/**
 * With `validation.approve_checks: ask` the user sees the chosen commands before any of them runs.
 * The reason none runs, or undefined when they run.
 */
async function skipReason(
  opts: ReviewChecksOptions,
  plan: ReviewChecksPlan,
): Promise<string | undefined> {
  if (resolveApproveChecks(opts.config) !== 'ask' || plan.commands.length === 0) return undefined;
  if (opts.onApproval === undefined) return REVIEW_CHECKS_SKIP_REASON.noScreen;
  const answer = await opts.onApproval({ scope: opts.scope, commands: plan.commands });
  throwIfAborted(opts.signal);
  if (answer === 'run') return undefined;
  return answer === 'skip' ? REVIEW_CHECKS_SKIP_REASON.user : REVIEW_CHECKS_SKIP_REASON.noAnswer;
}

function skippedSection(
  plan: ReviewChecksPlan,
  reason: string,
  waitingLines: readonly string[],
): string {
  return [
    '## Reviewer checks',
    '',
    `SPLITBRIEF ran none of the commands you chose before this review because ${reason}. No command below is a pass. Mark a criterion that only these commands would verify unverified, and judge the rest only from the recorded evidence in the Checks Log.`,
    '',
    ...plan.commands.map((chosen) => `- ${chosen.id} \`${chosen.command}\`: not run, ${reason}`),
    ...waitingLines,
    ...planLines(plan),
  ].join('\n');
}

/** A repeated review re-runs its commands: their earlier inputs give way to this run's. */
function replaceReviewCheckInputs(
  ref: { projectDir: string; sessionId: string },
  state: WorkflowState,
  inputs: readonly TriageInput[],
): WorkflowState {
  const pending = state.pendingTriage;
  const kept = (pending?.inputs ?? []).filter((input) => !REVIEW_CHECK_INPUT_ID.test(input.id));
  if (inputs.length === 0 && kept.length === (pending?.inputs.length ?? 0)) return state;
  return transitionAndSave(ref, state, {
    type: 'QUEUE_TRIAGE',
    inputs: [...kept, ...inputs],
    ...(pending?.question !== undefined && { question: pending.question }),
  });
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
    return { kind: 'ran', state, section: OFF_SECTION, discharged: [], preExistingChecks: [] };
  }

  const npmScriptsApproved = planApprovesNpmScripts({ config: opts.config, state });
  const readsOwnFiles = resolveReviewerRunner(opts.config).runner.kind !== 'api';
  const requiredCommands = (state.pendingReviewCommands ?? []).slice(0, MAX_REVIEW_CHECKS);
  const waitingLines = (state.pendingReviewCommands ?? [])
    .slice(MAX_REVIEW_CHECKS)
    .map(
      (command) =>
        `- \`${command}\`: not run, a fix check ran it and the plan holds at most ${MAX_REVIEW_CHECKS} commands; it stays pending`,
    );
  const prompt = buildReviewChecksPrompt({
    scope: opts.scope,
    taskIds: opts.taskIds,
    request: plannerFeature(state.feature, state.plannerContext),
    plan: reviewPlanData(state),
    operatorInstructions: reviewOperatorInstructions(
      state,
      opts.scope === 'task' ? opts.taskIds : undefined,
    ),
    changedFiles: opts.changedFiles,
    preRunFiles: opts.preRunFiles,
    requiredCommands,
    ...(readsOwnFiles
      ? { workspaceInstructions: workspaceReadInstructions(opts.workspaceDir) }
      : { projectFiles: await readProjectFiles(opts.workspaceDir) }),
  });
  const planSchema = ReviewChecksPlanSchema.superRefine((candidate, ctx) => {
    const firstCommands = candidate.commands.slice(0, requiredCommands.length);
    for (const command of requiredCommands) {
      if (firstCommands.some((chosen) => chosen.command === command)) continue;
      ctx.addIssue({
        code: 'custom',
        message: `commands: choose \`${command}\` among the first ${requiredCommands.length} commands, with this exact text; a fix check ran it and no review has run it since`,
      });
    }
  });
  const call = await runReviewerCall({
    reviewer: opts.reviewer,
    prompt,
    schema: planSchema,
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
  const skipped = await skipReason(opts, plan);
  if (skipped !== undefined) {
    state = transitionAndSave(ref, state, {
      type: 'RECORD_REVIEW_CHECKS',
      record: { ...record, skipped: { reason: skipped } },
    });
    publishReviewChecksPlan(notices, {
      scope: opts.scope,
      status: 'skipped',
      plan,
      reason: skipped,
    });
    state = replaceReviewCheckInputs(ref, state, []);
    return {
      kind: 'ran',
      state,
      section: skippedSection(plan, skipped, waitingLines),
      discharged: [],
      preExistingChecks: [],
    };
  }

  const base = runBaseOf(ref, state);
  const checkOptions: RunChecksOptions = {
    plan: state.plan,
    tasks: state.tasks,
    reviewChecks: reviewCheckList(record),
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
  const ranRequiredCommands = new Set<string>();
  const preExistingChecks: NonNullable<ReviewRecord['preExistingChecks']> = [];
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
    const { run, fresh, unavailable, notVerified } = await runReviewCheck({
      check: chosen,
      moment: 'pre-review',
      checkOptions,
    });
    runs.push(run);
    if (run.status !== 'pass' && run.status !== 'fail') {
      lines.push(`- ${label}: ${run.status === 'refused' ? 'refused' : 'not run'}, ${run.output}`);
      continue;
    }
    if (requiredCommands.includes(chosen.command)) ranRequiredCommands.add(chosen.command);
    if (run.status !== 'fail') {
      lines.push(`- ${label}: passed`);
      continue;
    }
    const preExisting = run.preExisting ?? [];
    if (preExisting.length > 0) {
      preExistingChecks.push({ id: chosen.id, command: chosen.command, keys: [...preExisting] });
    }
    lines.push(
      notVerified === undefined
        ? `- ${label}: failed, ${fresh.length} new failure(s)${
            preExisting.length > 0
              ? `; ${preExisting.length} pre-existing (also red at the run base)`
              : ''
          }${unavailable === undefined ? '' : `; base re-run ${unavailable}`}`
        : `- ${label}: failed, not verified at the run base (${notVerified}); the reviewer decides`,
      checkFailureText(run),
    );
    if (fresh.length === 0) continue;
    stoppedBy = chosen.id;
    const named = failingFilesFromKeys(fresh, opts.workspaceDir);
    for (const file of named.length > 0 ? named : [null]) {
      const owner = fileOwnerSentence(ledger, state.tasks, file);
      const failureKeys = failureKeysForFile({ failure: { ...run.failure, keys: fresh }, file });
      inputs.push({
        id: `${chosen.id}.${inputs.length + 1}`,
        kind: 'defect',
        source: 'check',
        file,
        text: `Reviewer check ${chosen.id} (${chosen.command}) failed ${
          notVerified === undefined
            ? 'with new failures.'
            : run.base === undefined
              ? `and SPLITBRIEF could not verify its run base re-run (${notVerified}); the reviewer decides.`
              : `and failed at the run base too, but SPLITBRIEF could not verify it is the same failure (${notVerified}); the reviewer decides.`
        }${owner === undefined ? '' : ` ${owner}`}\n${checkFailureText(run, { file })}`,
        checkIds: [chosen.id],
        command: chosen.command,
        output: run.output,
        ...(failureKeys.length > 0 && { failureKeys }),
        ...(run.status === 'fail' && { redKeys: run.failure.keys }),
        ...(notVerified !== undefined && { notVerified }),
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
  state = replaceReviewCheckInputs(ref, state, inputs);
  const section = [
    '## Reviewer checks',
    '',
    'Before this review SPLITBRIEF ran the commands you chose, in the run workspace; their output is in the Checks Log. A failure marked pre-existing also fails at the run base: raise no finding for it. A failure marked not verified at the run base is red at the run base too, but SPLITBRIEF could not show it is the same failure, or SPLITBRIEF could not re-run it there: decide from the output. Each new or not verified failure is a pending input.',
    '',
    ...lines,
    ...waitingLines,
    ...planLines(plan),
  ].join('\n');
  return {
    kind: 'ran',
    state,
    section,
    discharged: [...ranRequiredCommands],
    preExistingChecks,
  };
}
