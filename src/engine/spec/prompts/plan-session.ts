import type { PlanProposal } from '../../../core/schemas/plan.js';
import { PROTECTED_PATHS_TEXT } from '../../../core/pipeline-spec/scope.js';
import { PACKAGE_TEST_COMMAND } from '../../../core/validation/stacks/typescript.js';
import { FILE_TESTS } from '../../orchestrator/planning/sanitize-discovered-validation.js';
import type { PlanCheckError } from '../plan-checks.js';
import { buildPrompt, instructionsSection, skillsSection } from './builder.js';
import { buildLanguageContextSections, type LanguageContext } from './language-context.js';
import { GATES_ARE_SPLITBRIEFS, SKILLS_WITH_EVERY_BRIEF } from './tasks.js';

/** The question rounds a planning session may ask before it must return a plan. */
export const MAX_QUESTION_ROUNDS = 2;

/** The implementer the tasks are sized for: its model, and the context it was measured at. */
export type BuildSeat = Readonly<{ model: string | undefined; contextTokens: number }>;

export type PlanSessionPromptInput = Readonly<{
  feature: string;
  projectContext: string;
  languageContext: LanguageContext;
  build: BuildSeat;
  /** `workflow.approve: plan`: the user approves the plan before any check runs. */
  approvesPlan: boolean;
  skillsContext?: string | undefined;
  codebaseContext?: string | undefined;
  /** The documents an earlier multi-step planning chain of this run wrote. */
  earlierPlanning?: string | undefined;
}>;

function buildSeatText(build: BuildSeat): string {
  const model = build.model === undefined ? 'the configured implementer' : `\`${build.model}\``;
  return `The tasks are built by ${model}, a weaker model with a measured context of ${build.contextTokens.toLocaleString('en-US')} tokens. Each task reaches it with the current code of its suggested and context files, the instructions and the checks, and the whole prompt must fit well inside that context with room left to work. A task is one verifiable behaviour with its tests and callers. Group by coherent outcome, not by count: every task costs a fixed overhead, and every task boundary is a place where one task can break another.`;
}

// A package script runs only after the user approved the plan that names it.
function packageScriptRule(approvesPlan: boolean): string {
  return approvesPlan
    ? 'A `cmd` check runs `npm run <script>` only for a script `package.json` defines; the plan approval confirms it.'
    : 'This run approves no plan, so SPLITBRIEF refuses a `cmd` check that runs a package script (`npm run <script>`): a package manager runs only as its bare `test` command.';
}

function fileTestRule(): string {
  const forms = Object.keys(FILE_TESTS).map((test) => `\`test ${test} <file>\``);
  const meanings = Object.values(FILE_TESTS);
  return `As a \`cmd\` check, ${forms.slice(0, -1).join(', ')} and ${forms.at(-1)} check that a file ${meanings.slice(0, -1).join(', ')} or ${meanings.at(-1)}; use them to check a file mode or a symbolic link instead of a new test file.`;
}

function planRules(approvesPlan: boolean): string {
  return `- Research the repository read-only. Do not edit, create or delete any file.
- Do not invoke a native user-question tool (AskUserQuestion or the like). SPLITBRIEF asks the user.
- Ask questions only when a decision that only the user can make blocks the plan: at most 3 questions per round, at most ${MAX_QUESTION_ROUNDS} rounds. Give every question a non-empty \`default\`, the answer the plan uses when the user just presses Enter. Give \`choices\` when the answer is one of a fixed set, else null; the \`default\` of a question with \`choices\` is one of them.
- Criteria are the contract. Give each one an id (\`C1\`, \`C2\`, …) and the \`checkIds\` that verify it. Every check id must exist in the run checks or in a task's checks, and every check id is unique. The ids \`V1\`, \`V2\`, … are the reviewer's: never give a check one of them.
- A check is \`test\` (a test file or pattern), \`cmd\` (a command) or \`render\` (a gallery scenario id). ${packageScriptRule(approvesPlan)} \`npx\` runs only as \`npx --no-install <stack tool>\`.
- A \`test\` check narrows \`${PACKAGE_TEST_COMMAND}\` to its file (\`${PACKAGE_TEST_COMMAND} -- <file>\`) only when the \`package.json\` test script is one command. A chained script (\`a && b\`) runs whole. To run one test file there, use a \`cmd\` check that runs the project's test runner on the file directly: \`node --test <test file>\`, \`npx --no-install vitest run <test file>\` or \`npx --no-install jest <test file>\`. \`node --check <file>\` checks the syntax of one file. ${fileTestRule()}
- Task ids are \`T001\`, \`T002\`, … in order. Every task serves at least one criterion, every criterion is served by at least one task, and every task has at least one check.
- Each task completes one verifiable behaviour, including its tests and the caller changes it needs. Its \`intent\` names the behaviour and its expected result, never only files. Never separate implement, test and caller tasks for one behaviour.
- Split a behaviour only when its task would not fit the implementer's context, and split it into behaviours that each verify on their own.
- \`suggestedFiles\`: the files the task writes, first the main one. At least one. They are guidance: the implementer may touch another ordinary file when the change needs it.
- \`contextFiles\`: the read-only files the implementer must see. SPLITBRIEF attaches their current code when it dispatches the task.
- Do not copy code into a task. Name the files; SPLITBRIEF attaches their current code.
- A task must not depend on anything outside its own fields and the plan context (summary, decisions, its criteria); do not refer to 'the plan' or to another task's text.
- \`exclusions\`: explicit "do not" notes. The reviewer checks them.
- \`steps\`: only where the approach is not obvious, else null.
- \`dependsOn\`: ids of earlier tasks in the same or an earlier batch. No cycles.
- \`batch\`: 1, 2, …. SPLITBRIEF runs every required check before every review, and the reviewer chooses the commands that verify the change. SPLITBRIEF builds the tasks in the order you list them, so list them in batch order and list each task after the tasks it depends on.
- A write to a protected path (${PROTECTED_PATHS_TEXT}) waits for the user to confirm it. List every such write the task needs in \`protectedOperations\` as \`{ "path": …, "operation": "write" }\`; the plan approval lists them. Use null when there is none.
- \`validation\`: the language and test command you found. A \`test\` check runs that command on its file. \`testPattern\` is a file name pattern with one \`*\`, such as \`*.test.js\` or \`test_*.py\`: no \`/\`, no \`\\\` and no \`..\`. SPLITBRIEF searches beside the changed file and in the stack's test folders. Use null for what you did not find.
- ${GATES_ARE_SPLITBRIEFS}`;
}

export function buildPlanSessionPrompt(input: PlanSessionPromptInput): string {
  return buildPrompt({
    title: 'Plan the change',
    intro:
      'You are the planner. In this one session you research the repository, decide what to build, and return one typed result: up to 3 questions for the user, or the plan. A weaker implementer builds each task of the plan, and SPLITBRIEF runs the checks.',
    sections: [
      { heading: 'Request', body: input.feature },
      { heading: 'Project Context', body: input.projectContext },
      ...skillsSection(input.skillsContext),
      ...(input.codebaseContext === undefined
        ? []
        : [{ heading: 'Repository Map', body: input.codebaseContext }]),
      ...buildLanguageContextSections(input.languageContext),
      ...(input.earlierPlanning === undefined
        ? []
        : [
            {
              heading: 'Earlier Planning',
              body: `This run started under an older multi-step planner. Use what it wrote as context, and return one plan for the whole request.\n\n${input.earlierPlanning}`,
            },
          ]),
      { heading: 'Implementer', body: buildSeatText(input.build) },
      instructionsSection(
        `${planRules(input.approvesPlan)}${input.skillsContext === undefined ? '' : `\n- ${SKILLS_WITH_EVERY_BRIEF}`}`,
      ),
    ],
    output:
      'Return exactly one JSON object `{ "result": … }`. `result.kind` is `questions` or `plan`. Every key is present; use null for an optional value you do not set.',
  });
}

/** One answered round, as a planner without a session of its own reads it back. */
export type PlanRound = Readonly<{ reply: string; answer: string }>;

export function planHistory(rounds: readonly PlanRound[]): string {
  if (rounds.length === 0) return '';
  return `## Conversation so far\n\n${rounds
    .map((round) => `Planner:\n${round.reply}\n\nUser:\n${round.answer}`)
    .join('\n\n')}`;
}

/** What the planner returns next, once `answered` question rounds are behind the session. */
function continuePlanning(answered: number): string {
  return answered < MAX_QUESTION_ROUNDS
    ? 'Continue the planning session and return the result: the plan, or questions only if a decision is still blocked.'
    : 'Continue the planning session. No question round remains: return the plan, and take the default of every question that is still open.';
}

/** The answers to round `round`, for a planner that holds its own session. */
export function planAnswersTurn(answers: string, round: number): string {
  return `The user answered:\n\n${answers}\n\n${continuePlanning(round)}`;
}

export function planRepairTurn(errors: readonly PlanCheckError[], plan?: PlanProposal): string {
  const failed = plan === undefined ? '' : `Your plan:\n${JSON.stringify(plan, null, 2)}\n\n`;
  return `${failed}The plan failed SPLITBRIEF's checks:\n${errors
    .map((error) => `- ${error.code}: ${error.message}`)
    .join('\n')}\n\nReturn the corrected complete plan.`;
}

/**
 * The whole session as a planner without a session of its own reads it: the prompt, what the user
 * asked of this session (a correction at the plan card, a steer), the rounds answered so far, and
 * the repair when the plan failed its checks.
 */
export function planFullTurn(
  prompt: string,
  rounds: readonly PlanRound[],
  repair?: Readonly<{ errors: readonly PlanCheckError[]; plan: PlanProposal }> | undefined,
  standing = '',
): string {
  const history = planHistory(rounds);
  const next =
    repair !== undefined
      ? planRepairTurn(repair.errors, repair.plan)
      : history === ''
        ? ''
        : continuePlanning(rounds.length);
  return [prompt, standing, history, next].filter((part) => part !== '').join('\n\n');
}

/** An older run rewound before it had a plan.json carries its earlier documents instead. */
export function planRevisedTurn(planJson: string, correction: string): string {
  const reviewed = planJson.trim();
  const plan = reviewed === '' ? '' : `\n\nThe plan they reviewed:\n${reviewed}`;
  return `The user asked for changes to the plan:\n\n${correction}${plan}\n\nReturn the corrected complete plan.`;
}
