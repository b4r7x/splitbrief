import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { BASELINE_RULE } from '../src/core/pipeline-spec/baseline.js';
import { BOUNDS } from '../src/core/pipeline-spec/bounds.js';
import { BRIEF_SECTION_ORDER, sliceRuleText } from '../src/core/pipeline-spec/brief.js';
import { CAPTURE_LIMITS, NARROWING_RULE } from '../src/core/pipeline-spec/gates.js';
import { HALT_SIGNATURES } from '../src/core/pipeline-spec/halts.js';
import { DEFAULT_LOCAL_RETRIES } from '../src/core/pipeline-spec/retries.js';
import { PROTECTED_PATHS_TEXT } from '../src/core/pipeline-spec/scope.js';
import { TIMEOUTS } from '../src/core/pipeline-spec/timeouts.js';
import type { CliEffortChannel } from '../src/core/runners/effort-channel.js';
import {
  CONSULT_ANSWER_JSON_SCHEMA,
  ConsultAnswerSchema,
  type ConsultAnswer,
  ImplementerReportSchema,
} from '../src/core/schemas/consult.js';
import type { EffortLevel } from '../src/core/schemas/enums.js';
import type { Plan } from '../src/core/schemas/plan.js';
import { MAX_REVIEW_CHECKS } from '../src/core/schemas/review.js';
import { RUNNER_IDLE_WARN_MS } from '../src/core/schemas/runner-fields.js';
import { TaskSchema } from '../src/core/schemas/task.js';
import { STACKS } from '../src/core/validation/stacks/registry.js';
import type { Stack, TestNarrowing } from '../src/core/validation/stacks/types.js';
import { consultAttemptError } from '../src/engine/orchestrator/escalation/consult-guidance.js';
import type {
  CliImplementerAdapter,
  CliPlannerAdapter,
} from '../src/engine/runners/cli-tools/contract.js';
import {
  CLI_IMPLEMENTER_ADAPTERS,
  CLI_PLANNER_ADAPTERS,
} from '../src/engine/runners/cli-tools/registry.js';
import { fallbackInstruction } from '../src/engine/runners/typed-output.js';
import { READ_ONLY_CONTEXT_HEADING, TASK_BRIEF_HEADINGS } from '../src/engine/spec/headings.js';
import { formatTaskPrompt } from '../src/engine/spec/prompt-formatter.js';
import { buildConsultPrompt } from '../src/engine/spec/prompts/consult.js';
import { buildLanguageContext } from '../src/engine/spec/prompts/language-context.js';
import { IMPLEMENTER_RUNS_NO_CHECKS, workspaceRules } from '../src/engine/spec/prompts/system.js';
import { buildTaskFormatExample } from '../src/engine/spec/prompts/task-format-example.js';

const ctx = buildLanguageContext('typescript');

const PLACEHOLDER_TASK = TaskSchema.parse({
  id: 'T001',
  title: '<title>',
  action: 'create',
  suggestedFiles: ['<file>'],
  dependsOn: [],
  description: "<the brief's Description>",
  signature: "<the brief's Signature, when it has one>",
  tests: ["<the brief's Tests bullets>"],
  constraints: ["<the brief's Constraints bullets>"],
  typeDefs: '',
  implementationSteps: [],
  status: 'pending',
});

const PLACEHOLDER_PLAN: Plan = {
  summary: '<the plan summary>',
  decisions: [],
  criteria: [{ id: '<C1>', text: '<what the criterion verifies>', checkIds: ['<K1>'] }],
  checks: [{ id: '<K1>', kind: 'test', value: '<the check file or command>', required: true }],
  validation: null,
};

const ERROR_PLACEHOLDER = '<gate tail>';

type Substitutions = ReadonlyArray<readonly [string, string]>;

const CLOSING_LINE_SUBSTITUTIONS: Substitutions = [
  ['directly in the isolation directory.', 'directly in the working directory.'],
  ['SPLITBRIEF runs the checks', 'The orchestrator runs the checks'],
];

function substitute(text: string, substitutions: Substitutions, source: string): string {
  let result = text;
  for (const [from, to] of substitutions) {
    if (!result.includes(from)) {
      throw new Error(`${source} no longer contains "${from}"; update its substitutions`);
    }
    result = result.replace(from, to);
  }
  return result;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.length === 0 ? '' : `    ${line}`))
    .join('\n');
}

const SHELL_WORD = /^[\w@%+=:,./$-]+$/;

function substituteArg(arg: string): string {
  if (arg === 'high') return '$E';
  if (arg.endsWith('=high')) return `${arg.slice(0, -'high'.length)}$E`;
  // The recipe runs inside `sh -c '…'`, so an argument that shell would unquote or split
  // (claude's `--settings` JSON) is single-quoted there with the `'\''` escape.
  if (!SHELL_WORD.test(arg)) return `'\\''${arg}'\\''`;
  return arg;
}

function recipeLine(
  adapter: CliPlannerAdapter | CliImplementerAdapter,
  args: readonly string[],
): string {
  const argv = `${adapter.descriptor.command} ${args.map(substituteArg).join(' ')} < $P`;
  return `nohup sh -c '${argv} > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID`;
}

/** The seat's effort reaches the tool through exactly one channel; the others send no flag. */
function effortInput(channel: CliEffortChannel): {
  effort: EffortLevel | undefined;
  variant: string | undefined;
} {
  return {
    effort: channel === 'effort-flag' ? 'high' : undefined,
    variant: channel === 'variant' ? 'high' : undefined,
  };
}

function seatLines(
  label: string,
  adapter: CliPlannerAdapter | CliImplementerAdapter,
  withModel: readonly string[],
  withoutModel: readonly string[],
): string[] {
  const full = recipeLine(adapter, withModel);
  const bare = recipeLine(adapter, withoutModel);
  const lines = [`- ${label}: \`${full}\``];
  if (bare !== full) lines.push(`- ${label} (no model): \`${bare}\``);
  return lines;
}

function toolRecipe(toolId: string): string | null {
  const implementer = Object.entries(CLI_IMPLEMENTER_ADAPTERS).find(([id]) => id === toolId)?.[1];
  const planner = Object.entries(CLI_PLANNER_ADAPTERS).find(([id]) => id === toolId)?.[1];
  if (implementer === undefined || planner === undefined) return null;
  const seat = effortInput(implementer.descriptor.effortChannel);
  const bare = { effort: undefined, variant: undefined };
  const implementerInput = { projectDir: '$D', configuredArgs: [] };
  // A skill's review spawn is detached and never resumed.
  const plannerInput = {
    ...implementerInput,
    sessionId: null,
    oneShot: true,
  };
  return [
    ...seatLines(
      'implementer',
      implementer,
      implementer.baseArgs({ ...implementerInput, model: '$M', ...seat }),
      implementer.baseArgs({ ...implementerInput, model: undefined, ...bare }),
    ),
    ...seatLines(
      'reviewer',
      planner,
      planner.baseArgs({ ...plannerInput, model: '$M', ...seat }),
      planner.baseArgs({ ...plannerInput, model: undefined, ...bare }),
    ),
  ].join('\n');
}

function preamble(): string {
  return indent(
    [
      `SYSTEM: Write ${ctx.language} code directly in the working directory.`,
      workspaceRules('<project dir>'),
      suggestedFiles(),
      `Use ${ctx.importConvention}. Follow the project's instruction files.`,
      'Read the suggested files and the attached context before editing.',
      'Treat steps as guidance. Keep the accepted criteria and explicit exclusions.',
      substitute(
        IMPLEMENTER_RUNS_NO_CHECKS,
        [['SPLITBRIEF runs', 'The orchestrator runs']],
        'gate rule',
      ),
      'In these skills, render checks are unavailable. Do not claim render evidence.',
      implementerReport(),
    ].join('\n'),
  );
}

function reviewPacket(): string {
  return indent(`# Implementation review

Read the workspace without editing it. Answer from this packet and the current code.

## Approved plan
<plan.json, completed tasks and the criteria due at this review>

## Plan context
<summary, decisions with task ids, and criterion text>

## Task Briefs
<completed tasks' Markdown briefs in full; pending tasks listed separately>

## Implementation Diff
<current run diff against the saved baseline, grouped by task>

## Changed files
<per-task changed paths and touchedNotSuggested entries with reasons>

## Recorded Validation Output
<reviewer check output and required checks by id, with commands, exits and artifact paths>

## Consults and user answers
<consult log, previous review answers, rejected findings with reasons, and user answers>

## Instructions
Check the accepted behaviour, exclusions, edge cases, tests and repository rules.
Quote recorded output for each validation claim. State when evidence is absent.
Only registered check ids can verify a criterion. Old evidence cannot verify changed code.
Pending criteria are pending. Do not report them as a plan gap.
Render checks are unavailable in these skills. A required render criterion stays unverified.

## Typed answer
Return one JSON object with tasks, criteria, findings, fixTasks, rejected, verify and ask.
Tasks use plan: met, partial or missed. Criteria use status: pass, fail or unverified, with evidence.
Findings use kind: defect, plan-gap, unverified or question; severity: blocking or minor.

Use taskId to identify a task. Use checkIds or criterionId for an unverified finding.
Include exactly one result for each completed task and each criterion due now.
Address every pending input in this same answer. Write fix tasks as complete TaskSpecs with new ids and findingIds.

Use rejected entries with findingId and reason. Use verify entries with findingId and registered checkIds.
Set ask to null or a user-only question with question and whyOnlyUserCanAnswer.
Use this example shape, with real ids and evidence:

{"tasks":[{"id":"T001","plan":"met","note":"<evidence>"}],"criteria":[{"id":"C1","status":"pass","evidence":"<recorded proof>"}],"findings":[{"id":"F1","kind":"question","severity":"blocking","taskId":"T001","file":null,"line":null,"text":"<question>","acceptance":null,"checkIds":null,"criterionId":null}],"fixTasks":[],"rejected":[],"verify":[],"ask":{"question":"<question>","whyOnlyUserCanAnswer":"<missing product decision>"}}

Use empty arrays when there are no entries. Save the whole answer in review.json. The session derives the verdict.`);
}

function implementerReport(): string {
  const report = ImplementerReportSchema.parse({
    status: 'done',
    filesChanged: ['<file>'],
    touchedNotSuggested: [{ file: '<file>', reason: '<reason>' }],
    notes: null,
  });
  const blocked = ImplementerReportSchema.parse({
    status: 'blocked',
    question: '<question>',
    filesNeeded: ['<file>'],
  });
  return [
    'The report is advisory. Recorded checks decide whether the task passes.',
    'End with one JSON object and nothing after it. Use decisions: [] when you propose no deviation.',
    JSON.stringify({ ...report, decisions: [{ what: '<proposed deviation>', why: '<reason>' }] }),
    `If blocked, end with ${JSON.stringify(blocked)} instead. The session consults at once.`,
    'A decision states a deviation and why. The plan ledger records it with the task id, and the reviewer judges it.',
  ].join('\n');
}

function briefTemplate(): string {
  const template = buildTaskFormatExample(ctx)
    .replace(
      'What to implement and why. Include all context the implementer needs.',
      'What to implement and why. Include all context the implementer needs.\n\n' +
        '**Plan context (read-only):**\n' +
        '<plan summary>\n' +
        'Decisions: <plan decisions, including task ids>\n' +
        'Criteria this task serves: <criterion ids and text>',
    )
    .replace('3. 3-5 steps max\n', '')
    .replace(
      'A further path the planner already approved',
      'A further ordinary file the planner suggests',
    )
    .replace('Stop and ask when', 'Stop and report to the planner when');
  return indent(
    `${template}\n\n**Implementer report:**\n${implementerReport()}\n` +
      'No proposed deviation: {"status":"done","filesChanged":["<file>"],"touchedNotSuggested":[],"decisions":[],"notes":null}',
  );
}

/**
 * The consult contract: the prompt the consulted seat answers, rendered with placeholders, and
 * the error block the one post-consult attempt retries with.
 */
function consultContract(): string {
  const prompt = buildConsultPrompt({
    workspaceDir: '<the run workspace>',
    seat: 'plan',
    reason: 'failed',
    plan: PLACEHOLDER_PLAN,
    task: PLACEHOLDER_TASK,
    revisions: [],
    taskDiff: {
      diffs: [{ path: '<brief file>', diff: "<the diff from the task's start to now>" }],
      otherFiles: ['<other changed file>'],
    },
    failedAttempts: [
      {
        attempt: 1,
        taskId: PLACEHOLDER_TASK.id,
        revision: 1,
        line: '<the first error line of that attempt>',
      },
    ],
    failingOutput: ERROR_PLACEHOLDER,
    report: {
      status: 'done',
      filesChanged: ['<file>'],
      touchedNotSuggested: [],
      decisions: [],
      notes: null,
    },
    earlierConsults: [],
    otherTasks: [],
    operatorInstructions: [],
  });
  return [
    indent(prompt + fallbackInstruction(CONSULT_ANSWER_JSON_SCHEMA)),
    '',
    "The guidance of a `guidance` or `ask-user` answer is appended to the failed attempt's error block, not prefixed to it:",
    '',
    indent(
      consultAttemptError({
        lastError: ERROR_PLACEHOLDER,
        instructions: '<the instructions and context>',
        seat: 'plan',
      }),
    ),
    '',
    `The composed error block is truncated to ${BOUNDS.consultFailingOutputChars} characters.`,
    '',
    "Attach Plan context: the summary, decisions with task ids, and the task's criterion text.",
    'Attach proposed decisions from the report.',
  ].join('\n');
}

function bullets(lines: readonly string[]): string {
  return lines.map((line) => `- ${line}`).join('\n');
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function consultTable(): string {
  const actions: Record<ConsultAnswer['answer']['action'], string> = {
    guidance: 'Keep the brief. Attach instructions and context for one more implementer attempt.',
    'rewrite-task':
      'Replace the TaskSpec at the same id and the same criteria. Raise its revision.',
    'split-task': 'Keep all criteria. Re-point pending dependents to all children.',
    verify: 'Run the brief gate and named registered checks. Make no implementer call.',
    'ask-user': 'Ask only when the user alone can answer. Record why, choices and a default.',
  };
  return [
    `Attempt → ${DEFAULT_LOCAL_RETRIES} local retry with the exact errors → a consult.`,
    'A plan task consults the planner. A fix task the reviewer wrote consults the reviewer, also after a rewrite or a split.',
    'The planner continues its planning session. The reviewer reads the full fix context without a session.',
    'Record a malformed answer as a failure of the seat that answered. Apply no action.',
    '',
    table(
      ['Action', 'Next step'],
      ConsultAnswerSchema.shape.answer.options.map((option) => {
        const action = option.shape.action.value;
        if ('tasks' in option.shape) {
          const limits = z.toJSONSchema(option.shape.tasks);
          return [
            `\`${action}\``,
            `Replace with ${limits.minItems}–${limits.maxItems} subtasks. ${actions[action]}`,
          ];
        }
        return [`\`${action}\``, actions[action]];
      }),
    ),
    '',
    `Keep lineage counters across splits and resume: ${BOUNDS.consultsPerLineage} consults and ${BOUNDS.attemptsPerLineage} attempts.`,
    `Keep the run counter: ${BOUNDS.plannerCallsPerRun} planner decisions after planning. Reviewer consults and review answers spend no planner decision.`,
    'A blocked report consults at once.',
    'A guarded rewrite or split asks the operator on the consulted seat before dispatch.',
    'A done report records its decisions in the plan ledger with the task id before validation. No seat confirms them, and a retry records only a new decision.',
    'Reported decisions spend no run counter, never a lineage consult or a planner decision.',
    'A done report field that breaks the contract reads as empty with a warning. The other fields stay.',
    'When a bound is spent, halt as needs you and keep the work. Ask: continue with a note / skip / end.',
    `Continuing grants ${BOUNDS.extraConsultsPerLineage} more consult and ${BOUNDS.extraAttemptsPerLineage} more attempts, or ${BOUNDS.extraPlannerCallsPerRun} more planner decisions, and replays the brief as a retry with the last failing output.`,
  ].join('\n');
}

function seatRecovery(): string {
  return bullets([
    `Transient seat failures permit ${BOUNDS.transientRetries} retries with backoff.`,
    `A usage match with a reported reset within ${BOUNDS.rateLimitResetWaitMs / 60_000} minutes permits a bounded wait up to that limit.`,
    'After the wait bound, halt as seat down and ask the user. Longer or unknown resets need the user immediately.',
    'An account refusal — balance, billing, a quota with no reset, or sign-in — halts at once as seat down.',
    'A declared `fallback` switches the seat once per run with no question.',
    'The `retry-later` action reads `Retry at <clock>`, and is offered only with a known reset.',
  ]);
}

const HALT_KINDS = {
  inputTooLarge: 'input-too-large',
  auth: 'auth',
  usage: 'usage',
  missingModel: 'missing-model',
  spawnFailure: 'spawn',
} as const satisfies Record<keyof typeof HALT_SIGNATURES, string>;

function haltGroups(): readonly (readonly [string, readonly string[]])[] {
  return Object.entries(HALT_KINDS).map(([key, kind]) => [
    kind,
    HALT_SIGNATURES[key as keyof typeof HALT_SIGNATURES],
  ]);
}

function haltSignatures(): string {
  return table(
    ['Kind', 'Signatures'],
    haltGroups().map(([kind, phrases]) => [kind, phrases.map((p) => `\`${p}\``).join(', ')]),
  );
}

function haltSignaturesSh(): string {
  const arms = haltGroups().map(
    ([kind, phrases]) => `  ${phrases.map((p) => `*'${p}'*`).join(' | ')}) halt=${kind} ;;`,
  );
  return ['case "$tail_text" in', ...arms, 'esac'].join('\n');
}

function narrowingLabel(narrowing: TestNarrowing): string {
  switch (narrowing.kind) {
    case 'path-arg':
      return narrowing.separator === '--' ? 'path-arg (after `--`)' : 'path-arg';
    case 'package-arg':
    case 'cargo-target':
    case 'none':
      return narrowing.kind;
  }
}

// The defaults table probes each stack's `test` command in a synthetic project.
// The project carries the files that select the first test command branch.
const STACK_PROBE_FILES: ReadonlyArray<readonly [string, string]> = [
  ['tsconfig.json', '{}'],
  ['package.json', '{"scripts":{"test":"vitest run"},"devDependencies":{"typescript":"*"}}'],
  ['uv.lock', ''],
  ['go.mod', 'module probe\n'],
  ['Cargo.toml', ''],
];

function withProbeProject<T>(read: (projectDir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'skill-blocks-stacks-'));
  try {
    for (const [file, content] of STACK_PROBE_FILES) writeFileSync(join(dir, file), content);
    return read(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function command(value: string | null): string {
  return value === null ? 'none' : `\`${value}\``;
}

function stackMarkers(stack: Stack): string {
  return stack.markers
    .filter((marker) => typeof marker === 'string')
    .map((marker) => `\`${marker}\``)
    .join(', ');
}

function stackTestFiles(stack: Stack): string {
  const patterns = stack.testFilePatterns.map((pattern) => `\`${pattern}\``);
  if (stack.inlineTests !== undefined) patterns.push(`inline \`${stack.inlineTests.source}\``);
  return patterns.length === 0 ? 'none' : patterns.join(', ');
}

function gates(): string {
  const defaults = withProbeProject((dir) =>
    STACKS.map((stack) => [
      `${stack.language} (${stackMarkers(stack)})`,
      command(stack.test(dir)),
      stackTestFiles(stack),
    ]),
  );
  return [
    table(['Language (marker)', 'test check command', 'test files'], defaults),
    '',
    "A test check whose command resolves to nothing cannot run. The column shows the default with the language's own tooling present; the resolution order above still wins over it.",
    '',
    NARROWING_RULE.text,
    '',
    table(
      ['Language', 'test narrowing', 'allowed commands'],
      STACKS.map((stack) => [
        stack.language,
        narrowingLabel(stack.narrowing),
        stack.allowedCommands.map((name) => `\`${name}\``).join(' '),
      ]),
    ),
  ].join('\n');
}

function gateRules(): string {
  return bullets([
    'At workflow.review: task, run the brief checks and the checks of its due criteria after each brief. At workflow.review: end, run the brief checks after each brief, except a render check. A consult `verify` runs only the checks it names, and on a fix brief the failed checks that brief answers.',
    `End-of-run checks are on by default (\`validation.end_checks\`). With End-of-run checks on, the reviewer makes the plan call before each review. It reads the manifests, scripts, Makefile or justfile, CI configuration and README. It chooses at most ${MAX_REVIEW_CHECKS} reviewer checks (\`V1\`, \`V2\`, …), each with a reason. Each reviewer check must verify the change.`,
    'It names the related tests it declines and gives the reason. If it chooses no reviewer check, record its reason. At end cadence, the reviewer checks verify the whole change. A task-cadence review chooses the tests related to the changed files.',
    'A failed plan call halts the review the same way a failed verdict call does. It is never a pass.',
    'Run reviewer checks in order, in the run workspace, under the reviewer command policy. It admits any installed program of any language, such as `mvn test`, `bundle exec rspec` or `make check`.',
    'Refuse shell syntax, an environment prefix, a program run by path (`bin/test`), a shell or wrapper, and inline code. Refuse `npx` without `--no-install`, a download-and-run launcher or a setup command (`npm ci`, `pip install`, `go generate`). Refuse a program that does not verify a change. Refuse a reviewer check whose package script, task file, build wrapper or interpreter script the run changed. Name each refused reviewer check with its reason; a plan or task check is never refused for that. A plan may add a script and check it.',
    'Stop at the first reviewer check with new failures. Record each later reviewer check as `not run: <id> failed`. Re-run a red reviewer check at the run base with the same command text. A failure also red there is pre-existing. Report it and assign no fix task to it.',
    'A timeout, or a red with no failure keys, is never pre-existing. Report it as not verified at the run base and send it to the reviewer. Plan checks, task checks and the Apply re-check never re-run at the run base.',
    'A red required check, or a new or not verified reviewer failure, becomes a pending input. The reviewer addresses every pending input in its review answer and writes the fix tasks. No completed brief reopens. The fix task carries the check id, command, output, file, its own `failureKeys` and all original `redKeys` per check id. Keep every original red key before the base split. Two fix tasks may share the failures of one pending input.',
    'Keys come from the full process capture. A test row without FAILED or ERROR and a row with warning severity are not failure keys. SPLITBRIEF reads the severity where the tool prints it, not in the message text. An incomplete capture gives one placeholder key. With an incomplete capture, the fix command must pass.',
    'At either cadence, the brief gate of a fix task runs each carried check once under the same command policy. It makes no base re-run. A red passes when no own failure remains. An own failure that an unfinished fix task of the same cycle also carries is left to that task. Failures the task does not own do not gate it: their fix tasks or the next review answer them.',
    "When every own failure of a carried check is a test failure, run the stack's test runner on the own test files only. The full command runs at the next review. A type check, a lint, an unknown stack and a configured test command keep the full command.",
    'A diagnostic key includes its path, position and message. Match exact keys first. Then pair unmatched diagnostics by message identity, with only the position removed. Pair each key once. Test failures match by name. Keys with no file match exactly.',
    'Every unmatched re-run key counts as another failure. A check id with no own failures does not gate the brief when its findings carry failures for another check id. A check with no carried keys, or a re-run with no named failure, must pass its command. Older saved fix tasks without own keys still load and must pass their commands.',
    'The rule covers reviewer, plan and task checks. Each judged re-run gets a fix check verdict row. A settled re-run reads `your 2 failures gone · 3 others left for their fix tasks or the next review`. A shared failure reads `1 left to T025`. Plan and task checks get only a done row, with no duration. An own failure that remains fails the gate and retries through its ladder before the next review.',
    'With End-of-run checks off, no reviewer check runs and one row says so. Plan and task checks still run.',
    'The next review chooses and runs its reviewer checks again. Log check ids, commands, output, exits and artifact paths in validation.md. Re-run checks when the candidate changes. Earlier green output cannot verify changed code.',
    'Format the brief changed files with the project formatter after every hand-back. A formatter failure records a warning.',
    `Display at most ${CAPTURE_LIMITS.outputChars} characters per command, and keep the LAST ${CAPTURE_LIMITS.testTailLines} lines of a test command — runners print the pass/fail summary last.`,
    `Narrowing kinds: ${NARROWING_RULE.kinds.map((kind) => `\`${kind}\``).join(', ')}.`,
  ]);
}

// The skill spawns direct writers only: the CLI sends a direct writer no `### Current Code`, and
// puts the read-only context code where the current code would stand.
function bodyOrder(): string {
  const currentCode = TASK_BRIEF_HEADINGS.currentCode.heading;
  const headings = BRIEF_SECTION_ORDER.map((heading) =>
    heading === currentCode ? `${READ_ONLY_CONTEXT_HEADING} — <path>` : heading,
  );
  return [
    ...headings.map((heading, index) => `${index + 1}. \`${heading}\``),
    '',
    `\`${currentCode}\` is never sent to a direct writer: the tool reads the file itself. A \`${READ_ONLY_CONTEXT_HEADING} — <path>\` section carries the current code of each context file, one per file.`,
  ].join('\n');
}

function completionInstruction(files: readonly [string, ...string[]]): string {
  const prompt = formatTaskPrompt({
    task: { ...PLACEHOLDER_TASK, suggestedFiles: [...files] },
    context: { name: '<project>', dir: '$D' },
    writesFiles: 'direct',
  });
  const line = prompt.split('\n').at(-1) ?? '';
  return substitute(line, CLOSING_LINE_SUBSTITUTIONS, 'closing line');
}

function closingLine(): string {
  return bullets([
    `one file: \`${completionInstruction(['<file>'])}\``,
    `more than one file: \`${completionInstruction(['<file>', '<second file>'])}\``,
  ]);
}

function suggestedFiles(): string {
  return bullets([
    'Suggested files are guidance. Edit another ordinary project file when needed; name it with a reason in touchedNotSuggested.',
    `Protected writes always need user confirmation: ${PROTECTED_PATHS_TEXT}.`,
    'Only an explicit user approval confirms a path and operation. A task request alone grants no confirmation.',
  ]);
}

function baselineRule(): string {
  return bullets([
    `Fingerprint \`${BASELINE_RULE.fingerprint}\`, one line per file in \`${BASELINE_RULE.file}\`.`,
    BASELINE_RULE.text,
  ]);
}

function timeouts(): string {
  return bullets([
    'Seat calls have no default deadline. Use `scripts/wait-attempt.sh <run> <T00N> <n> --deadline <seconds>` only for an explicit `timeout`.',
    `Monitor output silence. Warn after \`idleWarnMs\`, default ${RUNNER_IDLE_WARN_MS} ms. Continue the call after the warning.`,
    'Only an explicit `timeout` or `idleKillMs` limits a call. Without either limit, never kill a silent call.',
    `${TIMEOUTS.consecutiveTimeoutsHalt} consecutive timeouts on one brief with an explicit limit cause a hard halt.`,
    'At an explicit deadline, the waiter attempts to terminate a separate process group when it can identify one, otherwise only the recorded PID. Never wrap a spawn in coreutils `timeout`. It does not exist on stock macOS.',
  ]);
}

function waitProtocol(): string {
  return [
    `1. **Spawn.** One tool call, detached, writing \`<run>/T00N/attempt-N.{pid,log,done}\`: \`nohup sh -c '<argv> > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID\`. The wait is never in the same tool call as the spawn — never \`nohup … &\` and the wait in one call, and never a command that begins with \`sleep\`.`,
    '2. **Wait.** Run `scripts/wait-attempt.sh <run> <T00N> <n>` in a separate tool call. It waits until `.done` exists or the pid is gone. It prints one line: `T00N attempt N: exit=<code>|timeout|no-done|missing-pid[ halt=<kind>]`. On Claude Code, use `run_in_background: true`. The completion notification names the outcome. Elsewhere, run it in the foreground. Add `--deadline <seconds>` only for an explicit limit. Without it, the waiter never kills the call. Monitor silence using references/tool-recipes.md.',
    '   Fallback, when the installer dropped `scripts/`: `pid=$(cat "$PID"); until [ -f "$DONE" ] || ! kill -0 "$pid" 2>/dev/null; do sleep 5; done; cat "$DONE" 2>/dev/null || echo no-done`. For an explicit limit, set `N` to seconds and use `(pid=$(cat "$PID"); elapsed=0; until [ -f "$DONE" ] || ! kill -0 "$pid" 2>/dev/null; do [ "$elapsed" -ge "$N" ] && { echo exit=timeout; exit; }; sleep 1; elapsed=$((elapsed + 1)); done; cat "$DONE" 2>/dev/null || echo no-done)`. Read the halt phrases from the log. If an explicit limit expires, reconcile the recorded PID and its implementer children. Confirm they are gone, or stop them and confirm exit, before recovery or another dispatch.',
    "3. **Re-read every turn.** Read `.splitbrief/current-run`, `progress.md` and `scripts/wait-attempt.sh --reconcile <run>`. Read a finished process's log and run its checks before marking the task done. Never re-spawn a live pid. Preserve counters and decisions.",
    '4. **Monitor (Claude Code, optional).** A persistent `Monitor` on `tail -f <run>/events.log` filtering `done|failed|timeout|halted|run: complete` wakes the session on any terminal state. It is a whole-run wake, never the single-completion primitive — the waiter of point 2 stays.',
    '5. **Stop-hook safety net.** If the user authorized a host hook, use `scripts/splitbrief-gate.sh`. It checks continuation, not task success. Recorded checks still decide.',
  ].join('\n');
}

function verdictRules(): string {
  return bullets([
    'Derive pass: every task met, every criterion pass, no blocking finding.',
    'Reject missing, duplicated or unknown task and criterion ids. Unverified criteria block pass.',
    'At task cadence, cover completed tasks and criteria due so far. Pending criteria are pending, never a gap.',
    'Generic validation does not prove an unrelated criterion. Evidence must cover the current candidate.',
    'Repair malformed typed output once. A second failure pauses the seat; it produces no verdict.',
    'Keep minor findings as notes.',
  ]);
}

function fixCycle(): string {
  return bullets([
    'Read fixTasks, rejected, verify and ask from the saved review fix part. Append fix tasks with new ids; done tasks stay done.',
    'Run registered checks for unverified findings. The reviewer answers question findings from the plan and code before asking the user.',
    'Keep criteria when repairing a check command. Ask the user before changing the accepted outcome.',
    'Run fix cycles until the review passes, at end and at task cadence.',
    'Prepare each fresh review with references/gates.md.',
    'When a review answer fixes nothing, or a fix cycle leaves the same blockers, halt as needs you and name them. Preserve open findings and never claim verification passed.',
  ]);
}

const BLOCKS: Record<string, () => string> = {
  'brief-template': briefTemplate,
  'implementer-preamble': preamble,
  'consult-contract': consultContract,
  'review-packet': reviewPacket,
  'verdict-rules': verdictRules,
  'fix-cycle': fixCycle,
  'consult-table': consultTable,
  'seat-recovery': seatRecovery,
  'halt-signatures': haltSignatures,
  'halt-signatures-sh': haltSignaturesSh,
  'gate-rules': gateRules,
  gates,
  'brief-grouping': sliceRuleText,
  'body-order': bodyOrder,
  'closing-line': closingLine,
  'suggested-files': suggestedFiles,
  'baseline-rule': baselineRule,
  timeouts,
  'wait-protocol': waitProtocol,
};

export const GENERATED_BLOCK_IDS: readonly string[] = [
  ...Object.keys(BLOCKS),
  ...Object.keys(CLI_IMPLEMENTER_ADAPTERS).map((id) => `recipe:${id}`),
];

export function renderBlock(id: string): string | null {
  if (id.startsWith('recipe:')) return toolRecipe(id.slice('recipe:'.length));
  const block = BLOCKS[id];
  return block === undefined ? null : block();
}
