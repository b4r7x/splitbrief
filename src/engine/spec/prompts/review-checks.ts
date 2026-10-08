import { MAX_REVIEW_CHECKS } from '../../../core/schemas/review.js';
import { fenced } from './builder.js';

/** One project file handed to a seat that reads no file of its own. */
export type ProjectFileText = { path: string; text: string; trimmed: boolean };

export type ReviewChecksPromptInput = {
  scope: 'final' | 'task';
  /** The task ids a task-cadence review covers. */
  taskIds: readonly string[];
  changedFiles: readonly string[];
  /** The read instruction for a seat that reads the workspace itself. */
  workspaceInstructions?: string | undefined;
  /** Verbatim project files for a seat that reads no file of its own. */
  projectFiles?: readonly ProjectFileText[] | undefined;
  npmScriptsApproved: boolean;
  /** The programs the command policy lets a check start. */
  programs: readonly string[];
};

function scopeText(input: ReviewChecksPromptInput): string {
  if (input.scope === 'final') {
    return 'The review covers every change of this run. Choose the commands that verify this change as the project itself verifies a change: its tests, type checks and linters, the ones its scripts and CI run.';
  }
  return `The review covers the changes of ${input.taskIds.join(', ')}. Choose the commands that run the tests related to the files below, and the checks that cover them. Do not choose the whole suite.`;
}

function rules(input: ReviewChecksPromptInput): string {
  return [
    `- Choose at most ${MAX_REVIEW_CHECKS} commands, with the ids V1, V2, … in the order they run. The run stops at the first command with new failures; the rest do not run.`,
    '- Write each command as one program and its arguments. No shell operator (`| & ; $ ( ) { }` or backticks), no environment variable prefix, no `cd`.',
    `- The command policy starts only these programs: ${input.programs.map((program) => `\`${program}\``).join(', ')}. It refuses any other program, a program run by path, and inline code or a script file run through an interpreter.`,
    '- A package manager runs only its bare `test` command (for example `yarn test`). `npx` runs only `npx --no-install <tool>`. `uv run` and `poetry run` run only a listed Python tool. `make` and `just` run only one bare target named `typecheck`, `lint` or `test`.',
    input.npmScriptsApproved
      ? '- A package script runs as `npm run <script>`; the script must exist in package.json.'
      : '- Package scripts (`npm run <script>`) are refused in this run, because its plan was not approved. Choose the tools directly.',
    '- A command whose script or task file this run changed is refused. SPLITBRIEF names every refused command in the review.',
    '- Do not choose a command that deploys, publishes, needs credentials or a network service, watches files, or asks for input.',
    '- Every related test or check you do not run goes in `declined` with the reason.',
    '- When no command verifies this change, return no command and give the reason in `reason`.',
  ].join('\n');
}

/** The plan call: the reviewer chooses the reviewer checks SPLITBRIEF runs before the verdict. */
export function buildReviewChecksPrompt(input: ReviewChecksPromptInput): string {
  const parts = [
    '# Choose the checks for this review',
    'You review a SPLITBRIEF run. Before your review, SPLITBRIEF runs the commands you choose here in the run workspace and gives you every result in the review call. This call is read-only: do not run, write or change anything.',
    scopeText(input),
    '## Changed files',
    input.changedFiles.length === 0
      ? 'No file changed.'
      : input.changedFiles.map((file) => `- ${file}`).join('\n'),
    '## How to choose',
    input.workspaceInstructions === undefined
      ? 'Read the project files below: they are verbatim copies from the run workspace.'
      : `${input.workspaceInstructions} Read what the project has to learn how it verifies a change: its manifests and scripts, a Makefile or justfile, its CI configuration, its README.`,
    rules(input),
  ];
  for (const file of input.projectFiles ?? []) {
    parts.push(`### ${file.path}${file.trimmed ? ' (trimmed)' : ''}`, fenced(file.text));
  }
  parts.push(
    'Answer with one JSON object: `commands` ({ id, command, reason }), `declined` ({ target, reason }) and `reason` (null when you chose a command).',
  );
  return parts.join('\n\n');
}
