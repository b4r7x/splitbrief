import { TaskSchema } from '../src/core/schemas/task.js';
import { CLI_PROMPT_SENTINEL } from '../src/engine/runners/cli-tools/candidate-contract.js';
import type {
  CliImplementerAdapter,
  CliPlannerAdapter,
} from '../src/engine/runners/cli-tools/contract.js';
import {
  CLI_IMPLEMENTER_ADAPTERS,
  CLI_PLANNER_ADAPTERS,
} from '../src/engine/runners/cli-tools/registry.js';
import { CLOSING_CONSTRAINTS, RETRY_FRAMINGS } from '../src/engine/spec/prompt-formatter.js';
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

const ERROR_PLACEHOLDER = '<gate tail or drift list>';

// The CLI keys framings by attempt number; the skill keys them by position in the current ladder.
const RETRY_LABELS: Record<string, string> = {
  1: '1st local retry',
  2: '2nd local retry',
  3: 'hint rung',
};

// The skill runs in the project tree: there is no isolation directory and no promotion step.
export const PREAMBLE_SUBSTITUTIONS: ReadonlyArray<readonly [string, string]> = [
  [
    "directly in the isolation directory. Your changes are promoted into the user's project afterwards.",
    'directly in the working directory.',
  ],
  [
    'SPLITBRIEF runs them again after promotion and its verdict is the authority',
    'the orchestrator runs them again afterwards and its verdict is the authority',
  ],
];

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.length === 0 ? '' : `    ${line}`))
    .join('\n');
}

function substituteArg(arg: string): string {
  if (arg === CLI_PROMPT_SENTINEL) return '"$(cat $P)"';
  if (arg === 'high') return '$E';
  if (arg.endsWith('=high')) return `${arg.slice(0, -'high'.length)}$E`;
  return arg;
}

function recipeLine(
  adapter: CliPlannerAdapter | CliImplementerAdapter,
  args: readonly string[],
): string {
  const stdin = adapter.promptTransport.kind === 'stdin' ? ' < $P' : '';
  return `${adapter.descriptor.command} ${args.map(substituteArg).join(' ')}${stdin} > $LOG 2>&1`;
}

function toolRecipe(toolId: string): string | null {
  const implementer = Object.entries(CLI_IMPLEMENTER_ADAPTERS).find(([id]) => id === toolId)?.[1];
  const planner = Object.entries(CLI_PLANNER_ADAPTERS).find(([id]) => id === toolId)?.[1];
  if (implementer === undefined || planner === undefined) return null;
  const implementerArgs = implementer.baseArgs({
    prompt: CLI_PROMPT_SENTINEL,
    model: '$M',
    projectDir: '$D',
    configuredArgs: [],
    effort: 'high',
    variant: 'high',
  });
  const reviewerArgs = planner.baseArgs({
    prompt: CLI_PROMPT_SENTINEL,
    model: '$M',
    projectDir: '$D',
    configuredArgs: [],
    mode: 'plan',
    sessionId: null,
    effort: 'high',
    variant: 'high',
  });
  return [
    `- implementer: \`${recipeLine(implementer, implementerArgs)}\``,
    `- reviewer: \`${recipeLine(planner, reviewerArgs)}\``,
  ].join('\n');
}

function preamble(): string {
  let text = buildImplementerSystemPreamble(ctx, 'direct');
  for (const [from, to] of PREAMBLE_SUBSTITUTIONS) {
    if (!text.includes(from)) {
      throw new Error(
        `implementer preamble no longer contains "${from}"; update PREAMBLE_SUBSTITUTIONS`,
      );
    }
    text = text.replace(from, to);
  }
  return indent(text);
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

const BLOCKS: Record<string, () => string> = {
  'brief-template': () => indent(buildTaskFormatExample(ctx)),
  'brief-contract': () => briefContract(ctx),
  'critical-rules': () => criticalRules(ctx),
  'implementer-preamble': preamble,
  'closing-constraints': () => CLOSING_CONSTRAINTS.map((line) => `  - ${line}`).join('\n'),
  'retry-framings': () =>
    Object.entries(RETRY_FRAMINGS)
      .map(([attempt, framing]) => `| ${RETRY_LABELS[attempt] ?? attempt} | \`${framing}\` |`)
      .join('\n'),
  'hint-prompt': () => indent(buildHintPrompt(PLACEHOLDER_TASK, ERROR_PLACEHOLDER, ctx)),
  'takeover-prompt': () =>
    indent(
      buildEscalationPrompt({
        task: PLACEHOLDER_TASK,
        lastAttempt: "<the last attempt's final text>",
        error: ERROR_PLACEHOLDER,
        languageContext: ctx,
        outputMode: 'files',
      }),
    ),
  'review-packet': reviewPacket,
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
