import { MAX_REVIEW_CHECKS } from '../../../core/schemas/review.js';
import { REVIEWER_COMMAND_RULES } from '../../orchestrator/validation/reviewer-command-policy.js';
import { fenced } from './builder.js';

/** One project file handed to a seat that reads no file of its own. */
export type ProjectFileText = { path: string; text: string; trimmed: boolean };

export type ReviewChecksPromptInput = {
  scope: 'final' | 'task';
  /** The task ids a task-cadence review covers. */
  taskIds: readonly string[];
  changedFiles: readonly string[];
  requiredCommands: readonly string[];
  /** The read instruction for a seat that reads the workspace itself. */
  workspaceInstructions?: string | undefined;
  /** Verbatim project files for a seat that reads no file of its own. */
  projectFiles?: readonly ProjectFileText[] | undefined;
};

function scopeText(input: ReviewChecksPromptInput): string {
  if (input.scope === 'final') {
    return 'The review covers every change of this run. Choose the commands that verify this change as the project itself verifies a change: its tests, type checks and linters, the ones its scripts and CI run.';
  }
  return `The review covers the changes of ${input.taskIds.join(', ')}. Choose the commands that run the tests related to the files below, and the checks that cover them. Do not choose the whole suite.`;
}

function rules(): string {
  return [
    `- Choose at most ${MAX_REVIEW_CHECKS} commands, with the ids V1, V2, … in the order they run. The run stops at the first command with new failures; the rest do not run.`,
    "- Any installed program of the project's stack can run (`mvn test`, `bundle exec rspec`, `make check`, `npm run lint`). The command policy refuses what follows, and SPLITBRIEF names every refused command in the review.",
    ...REVIEWER_COMMAND_RULES.map((rule) => `  - ${rule}`),
    '- Reviewer package scripts need no plan approval. SPLITBRIEF checks every reviewer `npm run` script against the run base.',
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
    ...(input.requiredCommands.length === 0
      ? []
      : [
          '## Commands a fix check ran',
          input.requiredCommands.map((command) => `- \`${command}\``).join('\n'),
          'Fix checks ran these commands after the last review that ran them. Choose each of them first, as V1, V2, ..., with this exact command text, before any other command. A fix check can pass while the command still shows other failures, so this review runs them again.',
          ...(input.scope === 'task'
            ? ['For these commands, the whole-suite restriction above does not apply.']
            : []),
        ]),
    '## Changed files',
    input.changedFiles.length === 0
      ? 'No file changed.'
      : input.changedFiles.map((file) => `- ${file}`).join('\n'),
    '## How to choose',
    input.workspaceInstructions === undefined
      ? 'Read the project files below: they are verbatim copies from the run workspace.'
      : `${input.workspaceInstructions} Read what the project has to learn how it verifies a change: its manifests and scripts, a Makefile or justfile, its CI configuration, its README.`,
    rules(),
  ];
  for (const file of input.projectFiles ?? []) {
    parts.push(`### ${file.path}${file.trimmed ? ' (trimmed)' : ''}`, fenced(file.text));
  }
  parts.push(
    'Answer with one JSON object: `commands` ({ id, command, reason }), `declined` ({ target, reason }) and `reason` (null when you chose a command).',
  );
  return parts.join('\n\n');
}
