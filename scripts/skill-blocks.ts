import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { BASELINE_RULE } from '../src/core/pipeline-spec/baseline.js';
import {
  BRIEF_SECTION_ORDER,
  CLOSING_CONSTRAINTS,
  sliceRuleText,
} from '../src/core/pipeline-spec/brief.js';
import { CAPTURE_LIMITS, GATE_ORDER, NARROWING_RULE } from '../src/core/pipeline-spec/gates.js';
import { HALT_SIGNATURES } from '../src/core/pipeline-spec/halts.js';
import {
  HINT_ERROR_TEMPLATE,
  LADDER,
  MAX_HINT_ERROR_LENGTH,
  RETRY_FRAMINGS,
} from '../src/core/pipeline-spec/ladder.js';
import { DEFAULT_MODE, MODES } from '../src/core/pipeline-spec/modes.js';
import { DEFAULT_LOCAL_RETRIES } from '../src/core/pipeline-spec/retries.js';
import { REVIEW_CYCLE_CAP, VERDICT_RULES } from '../src/core/pipeline-spec/review.js';
import { SCOPE_RULE } from '../src/core/pipeline-spec/scope.js';
import { TIMEOUTS } from '../src/core/pipeline-spec/timeouts.js';
import type { CliEffortChannel } from '../src/core/runners/effort-channel.js';
import type { EffortLevel } from '../src/core/schemas/enums.js';
import { taskId, TaskSchema } from '../src/core/schemas/task.js';
import { STACKS } from '../src/core/validation/stacks/registry.js';
import type { Stack, TestNarrowing } from '../src/core/validation/stacks/types.js';
import { createStdoutTextSink } from '../src/engine/events/sinks/stdout-text.js';
import type { EngineEvent } from '../src/engine/events/types.js';
import { CLI_PROMPT_SENTINEL } from '../src/engine/runners/cli-tools/candidate-contract.js';
import type {
  CliImplementerAdapter,
  CliPlannerAdapter,
} from '../src/engine/runners/cli-tools/contract.js';
import {
  CLI_IMPLEMENTER_ADAPTERS,
  CLI_PLANNER_ADAPTERS,
} from '../src/engine/runners/cli-tools/registry.js';
import { TASK_BRIEF_HEADINGS } from '../src/engine/spec/headings.js';
import { formatTaskPrompt } from '../src/engine/spec/prompt-formatter.js';
import { buildEscalationPrompt, buildHintPrompt } from '../src/engine/spec/prompts/escalation.js';
import { buildLanguageContext } from '../src/engine/spec/prompts/language-context.js';
import { buildFinalReviewPrompt } from '../src/engine/spec/prompts/review.js';
import { buildImplementerSystemPreamble } from '../src/engine/spec/prompts/system.js';
import { buildTaskFormatExample } from '../src/engine/spec/prompts/task-format-example.js';
import { briefContract, criticalRules } from '../src/engine/spec/prompts/tasks.js';

const ctx = buildLanguageContext('typescript');

const PLACEHOLDER_TASK = TaskSchema.parse({
  id: 'T001',
  title: '<title>',
  action: 'create',
  file: '<file>',
  dependsOn: [],
  description: "<the brief's Description>",
  signature: "<the brief's Signature, when it has one>",
  tests: ["<the brief's Tests bullets>"],
  constraints: ["<the brief's Constraints bullets>"],
  typeDefs: '',
  implementationSteps: [],
  status: 'pending',
});

const ERROR_PLACEHOLDER = '<gate tail>';
const HINT_PLACEHOLDER = '<hint>';

type Substitutions = ReadonlyArray<readonly [string, string]>;

// The skill runs in the project tree, with this session as the orchestrator: there is no
// isolation directory, no promotion step and no SPLITBRIEF process.
export const PREAMBLE_SUBSTITUTIONS: Substitutions = [
  [
    "directly in the isolation directory. Your changes are promoted into the user's project afterwards.",
    'directly in the working directory.',
  ],
  ["SPLITBRIEF runs the project's typecheck", "The orchestrator runs the project's typecheck"],
  ['SPLITBRIEF and the review seat do that', 'the orchestrator and the review seat do that'],
];

const CLOSING_LINE_SUBSTITUTIONS: Substitutions = [
  ['directly in the isolation directory.', 'directly in the working directory.'],
  ['SPLITBRIEF runs the typecheck', 'The orchestrator runs the typecheck'],
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
  if (arg === CLI_PROMPT_SENTINEL) return '"$(cat $P)"';
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
  const stdin = adapter.promptTransport.kind === 'stdin' ? ' < $P' : '';
  const argv = `${adapter.descriptor.command} ${args.map(substituteArg).join(' ')}${stdin}`;
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
  const implementerInput = { prompt: CLI_PROMPT_SENTINEL, projectDir: '$D', configuredArgs: [] };
  // A skill's review spawn is detached and never resumed.
  const plannerInput = {
    ...implementerInput,
    mode: 'plan' as const,
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
  const text = buildImplementerSystemPreamble(ctx, 'direct', '<project dir>');
  return indent(substitute(text, PREAMBLE_SUBSTITUTIONS, 'implementer preamble'));
}

function reviewPacket(): string {
  return indent(
    buildFinalReviewPrompt({
      spec: '<spec.md when it exists; otherwise, per brief: `### T001 — <title>` + its Description, Tests, Scope>',
      taskBriefs: '<every brief in full>',
      diff: '<git diff of the changed set against the baseline tree; untracked new files via `git diff --no-index /dev/null <file>`>',
      driftReport: '<drift.md content, or `No drift: every changed file is owned by a brief.`>',
      validationEvidence:
        '<per brief: `### T001 — attempt N` then, per stage, the command on its own line and its captured output fenced>',
    }),
  );
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

function ladderTable(): string {
  return table(
    ['Rung', 'Who runs it', 'Attempts', 'Consumes a local retry'],
    LADDER.map((rung) => [
      `\`${rung.id}\``,
      rung.who,
      rung.count === 'DEFAULT_LOCAL_RETRIES' ? String(DEFAULT_LOCAL_RETRIES) : '1',
      `${rung.consumesRetry === false ? 'no' : 'yes'}${rung.optional === true ? ' (optional rung)' : ''}`,
    ]),
  );
}

const HALT_KINDS = {
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
    case 'name-filter':
      return `name-filter (\`${narrowing.flag}\`)`;
    case 'package-arg':
    case 'none':
      return narrowing.kind;
  }
}

// Every `Stack` command is a probe of the project, not a string: the defaults table is
// rendered by running the probes against a synthetic project that carries every config
// the registry knows, so each stage resolves to the command its first branch names.
const STACK_PROBE_FILES: ReadonlyArray<readonly [string, string]> = [
  ['tsconfig.json', '{}'],
  ['package.json', '{"scripts":{"test":"vitest run"},"devDependencies":{"typescript":"*"}}'],
  ['biome.json', '{}'],
  ['pyproject.toml', '[tool.mypy]\n[tool.ruff]\n'],
  ['uv.lock', ''],
  ['go.mod', 'module probe\n'],
  ['.golangci.yml', ''],
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
      command(stack.typecheck(dir)),
      command(stack.lint(dir)),
      command(stack.test(dir)),
      stackTestFiles(stack),
    ]),
  );
  return [
    table(['Language (marker)', 'typecheck', 'lint', 'test', 'test files'], defaults),
    '',
    "A stage whose command resolves to nothing is skipped. The columns show the default with the language's own tooling present; the resolution order above still wins over them.",
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
    `Order: ${GATE_ORDER.join(' → ')}. Stop at the first failing stage; every later stage is recorded \`not run\`.`,
    `Capture at most ${CAPTURE_LIMITS.outputChars} characters per stage, and keep the test stage's LAST ${CAPTURE_LIMITS.testTailLines} lines — runners print the pass/fail summary last.`,
    `Narrowing kinds: ${NARROWING_RULE.kinds.map((kind) => `\`${kind}\``).join(', ')}.`,
  ]);
}

function modesTable(): string {
  return [
    table(
      ['Mode', 'Planner calls', 'Approval gates'],
      Object.entries(MODES).map(([mode, spec]) => [
        `\`${mode}\``,
        String(spec.plannerCalls),
        spec.gates.length === 0 ? 'none' : spec.gates.join(', '),
      ]),
    ),
    '',
    `Default: \`${DEFAULT_MODE.skill}\`.`,
  ].join('\n');
}

// The skill spawns direct writers only, and the CLI sends a direct writer no `### Current Code`.
function bodyOrder(): string {
  const currentCode = TASK_BRIEF_HEADINGS.currentCode.heading;
  const headings = BRIEF_SECTION_ORDER.filter((heading) => heading !== currentCode);
  return [
    ...headings.map((heading, index) => `${index + 1}. \`${heading}\``),
    '',
    `\`${currentCode}\` is never sent to a direct writer: the tool reads the file itself.`,
  ].join('\n');
}

function completionInstruction(files: readonly [string, ...string[]]): string {
  const prompt = formatTaskPrompt({
    task: { ...PLACEHOLDER_TASK, file: files[0], files: [...files] },
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

function scopeRule(): string {
  return bullets([SCOPE_RULE.allowedSetText, SCOPE_RULE.driftText]);
}

function baselineRule(): string {
  return bullets([
    `Fingerprint \`${BASELINE_RULE.fingerprint}\`, one line per file in \`${BASELINE_RULE.file}\`.`,
    BASELINE_RULE.text,
  ]);
}

function timeouts(): string {
  const minutes = (ms: number): number => ms / 60_000;
  const deadline = TIMEOUTS.implementerMs / 1000;
  return bullets([
    `Implementer ${minutes(TIMEOUTS.implementerMs)} minutes per attempt, reviewer ${minutes(TIMEOUTS.reviewerMs)} minutes. ${TIMEOUTS.consecutiveTimeoutsHalt} consecutive timeouts on one brief = hard halt.`,
    `The waiter is its own deadline: \`scripts/wait-attempt.sh <run> <T00N> <n> --deadline ${deadline}\` kills the process group at ${minutes(TIMEOUTS.implementerMs)} minutes. Never wrap a spawn in coreutils \`timeout\` — it does not exist on stock macOS.`,
  ]);
}

function plainShapes(): string {
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
  const sink = createStdoutTextSink({ output });
  const ts = 0;
  const events: EngineEvent[] = [
    { type: 'workflow_started', ts, phase: 'implementing', feature: '<feature>' },
    {
      type: 'validate',
      ts,
      phase: 'implementing',
      taskId: taskId('T001'),
      status: 'done',
      passed: true,
      stages: { typecheck: true, lint: true, test: true },
    },
    {
      type: 'task_completed',
      ts,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: '<title>',
      method: 'local',
      retries: 0,
      duration: 0,
    },
    {
      type: 'validate',
      ts,
      phase: 'implementing',
      taskId: taskId('T002'),
      status: 'done',
      passed: true,
      stages: { typecheck: false, lint: false, test: false },
    },
    { type: 'task_full_fail', ts, phase: 'implementing', taskId: taskId('T002'), reason: 'test' },
    {
      type: 'cost_update',
      ts,
      phase: 'implementing',
      tokenUsage: {
        plannerInput: 90_000,
        plannerOutput: 12_000,
        implementerInput: 20_000,
        implementerOutput: 6400,
        escalationInput: 0,
        escalationOutput: 0,
        reviewerInput: 0,
        reviewerOutput: 0,
      },
    },
    { type: 'workflow_complete', ts, phase: 'complete', review: 'failed', completedTasks: 1 },
  ];
  for (const event of events) sink(event);
  return ['```', chunks.join('').trimEnd(), '```'].join('\n');
}

function waitProtocol(): string {
  const deadline = TIMEOUTS.implementerMs / 1000;
  return [
    `1. **Spawn.** One tool call, detached, writing \`<run>/T00N/attempt-N.{pid,log,done}\`: \`nohup sh -c '<argv> > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID\`. The wait is never in the same tool call as the spawn — never \`nohup … &\` and the wait in one call, and never a command that begins with \`sleep\`.`,
    `2. **Wait.** A separate tool call running \`scripts/wait-attempt.sh <run> <T00N> <n>\`: it blocks until \`.done\` exists or the pid is gone and prints one line, \`T00N attempt N: exit=<code>|timeout|missing-pid[ halt=<kind>]\`. On Claude Code run it with \`run_in_background: true\` — the completion notification names the outcome; elsewhere run it in the foreground. The waiter is its own deadline (\`--deadline ${deadline}\`); no coreutils \`timeout\` wrapper.`,
    `   Fallback, when the installer dropped \`scripts/\`: \`n=0; until [ -f "$DONE" ] || [ "$n" -ge ${deadline} ]; do sleep 5; n=$((n+5)); done; cat "$DONE" 2>/dev/null || echo exit=timeout\` — same deadline, no halt sniff, so read the halt phrases off the log yourself.`,
    '3. **Re-read every turn.** Every turn — user message, completion notification, hook follow-up, cron fire — begins with `cat .splitbrief/current-run` → `progress.md` → `scripts/wait-attempt.sh --reconcile <run>`, and rewrites every `running` row to `done` / `retrying` / `halted` before deciding anything. A running row whose pid is alive is never re-spawned.',
    '4. **Monitor (Claude Code, optional).** A persistent `Monitor` on `tail -f <run>/events.log` filtering `done|failed|timeout|halted|run: complete` wakes the session on any terminal state. It is a whole-run wake, never the single-completion primitive — the waiter of point 2 stays.',
    '5. **Stop-hook safety net.** Install `scripts/splitbrief-gate.sh` for the host: Claude Code `settings.json` `hooks.Stop`, Codex `~/.codex/hooks.json` `Stop`, Command Code `.commandcode/settings.json` `Stop`, Copilot `.github/hooks/*.json` `agentStop`, Cursor `.cursor/hooks.json` `stop` with `SPLITBRIEF_HOST=cursor`, Antigravity `hooks.json` `Stop` with `SPLITBRIEF_HOST=antigravity`. It is a safety net — every host caps consecutive continuations.',
    '6. **`--plain` fast path.** When `command -v splitbrief` and `.splitbrief/config.yaml` both exist, `splitbrief start --plain "<feature>"` (or `splitbrief resume --plain`) is the whole loop in one command; read its lines from the `plain-shapes` block instead of running this protocol.',
  ].join('\n');
}

function hintPlacement(): string {
  return [
    indent(HINT_ERROR_TEMPLATE(ERROR_PLACEHOLDER, HINT_PLACEHOLDER)),
    '',
    `The composed error block is truncated to ${MAX_HINT_ERROR_LENGTH} characters.`,
  ].join('\n');
}

function verdictRules(): string {
  return bullets([
    `Exactly one verdict word under \`### Verdict\`: ${VERDICT_RULES.words.map((word) => `\`${word}\``).join(' | ')}.`,
    `No single verdict word → ${VERDICT_RULES.unparseableReask} re-ask, verbatim: "${VERDICT_RULES.reaskSentence}" — a still-unparseable reply is \`${VERDICT_RULES.unparseableVerdict}\`.`,
    'Any Critical finding overrides a `pass`.',
    'A Critical finding names a code, test or behavior defect; an evidence-record gap alone is at most a Note and never causes `fail`.',
    'A finding belongs to the brief whose `files` names it (path substring); an unmatched finding goes to the last brief.',
  ]);
}

function fixCycle(): string {
  return bullets([
    `A \`${VERDICT_RULES.unparseableVerdict}\` verdict re-enters implementation: each Critical finding becomes the error block of the next attempt on its owning brief.`,
    `At most ${REVIEW_CYCLE_CAP} review cycles; the last \`fail\` ends the run as \`STOPPED at review\` with the findings listed.`,
  ]);
}

const BLOCKS: Record<string, () => string> = {
  'brief-template': () => indent(buildTaskFormatExample(ctx)),
  'brief-contract': () => briefContract(ctx),
  'critical-rules': () => criticalRules(ctx),
  'implementer-preamble': preamble,
  'closing-constraints': () => CLOSING_CONSTRAINTS.map((line) => `  - ${line}`).join('\n'),
  'retry-framings': () =>
    Object.entries(RETRY_FRAMINGS)
      .map(
        ([attempt, framing]) =>
          `| attempt ${attempt}${attempt === String(Object.keys(RETRY_FRAMINGS).length) ? '+' : ''} | \`${framing}\` |`,
      )
      .join('\n'),
  'hint-prompt': () => indent(buildHintPrompt(PLACEHOLDER_TASK, ERROR_PLACEHOLDER, ctx)),
  'takeover-prompt': () =>
    indent(
      buildEscalationPrompt({
        task: PLACEHOLDER_TASK,
        lastAttempt: "<the last attempt's final text>",
        error: ERROR_PLACEHOLDER,
        languageContext: ctx,
        isolationDir: '<project dir>',
        outputMode: 'files',
      }),
    ),
  'review-packet': reviewPacket,
  'verdict-rules': verdictRules,
  'fix-cycle': fixCycle,
  'ladder-table': ladderTable,
  'halt-signatures': haltSignatures,
  'halt-signatures-sh': haltSignaturesSh,
  'gate-rules': gateRules,
  gates,
  'modes-table': modesTable,
  'brief-grouping': sliceRuleText,
  'body-order': bodyOrder,
  'closing-line': closingLine,
  'scope-rule': scopeRule,
  'baseline-rule': baselineRule,
  timeouts,
  'plain-shapes': plainShapes,
  'wait-protocol': waitProtocol,
  'hint-placement': hintPlacement,
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
