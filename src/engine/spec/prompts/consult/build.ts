import type { ConsultReason } from '../../../../core/schemas/consult.js';
import type { ImplementerWriteMode } from '../../../../core/schemas/runner/implementer.js';
import type { Task } from '../../../../core/schemas/task.js';
import {
  type PromptPart,
  fenced,
  buildPrompt,
  instructionsSection,
  workspaceReadInstructions,
} from '../builder.js';
import { TASK_CMD_CHECK_RULE, DIRECT_WRITER_TASK_RULE } from '../plan-session.js';
import { GIT_READ_ONLY_RULE } from '../system.js';
import { decisionLines, planSection, taskBody, revisionSection, otherTaskLines } from './brief.js';
import { attemptLines } from './history.js';
import type { ConsultPromptInput } from './types.js';

const REASON_TEXT: Record<ConsultReason, string> = {
  failed: 'The task failed: its last attempt or one of its checks did not pass.',
  blocked: 'The implementer stopped and needs a decision that is not its own to make.',
  'no-progress':
    "The review made no progress: its blockers did not move after a fix cycle, its answer fixes none of them, or it failed with no blocker on criteria no check verified. The failing output lists your earlier answers on reviews without progress; choose again with them in view. guidance goes with the reviewer's next fix briefs, and needs at least one. A rewrite or a split replaces them. verify re-runs the named checks on the same tree, for a red that may be a flake, and the review runs again. accept leaves every remaining blocker open with your note and keeps the failed verdict; the user reads the note before Apply. A red check or an Apply conflict that blocks cannot be accepted: verify the red check or fix it. ask-user asks the user. cannot stops the run and asks the user.",
};

const ASK_USER_ACTION =
  '`ask-user` — `question`, `whyOnlyUserCanAnswer`, `choices` (or null) and `default` (or null): only when no other action can unblock the task and the user alone holds the missing decision.';

const CANNOT_ACTION =
  '`cannot` — `reason` and `next`: the task cannot be done as asked, and no guidance, rewrite, split or answer of the user can change that. `next` is the step for a user who chose Decide for me: `skip-brief` when the run can go on without this task, `end-run` when the rest of the run depends on it; null on a stuck review. SPLITBRIEF stops the brief and asks the user, or takes `next` after Decide for me.';

const CONSULT_CONTRACT_BODY = `SPLITBRIEF asks you, not the user, for the decision that unblocks this task. This call is read-only: do not write, edit or delete any file, and do not run commands that change the project. ${GIT_READ_ONLY_RULE}.

Answer with exactly one JSON object \`{ "answer": { "diagnosis": …, "action": … } }\`. \`answer.diagnosis\` states what actually went wrong, in one or two sentences, and is always present. Exactly one action follows it:
- \`guidance\` — \`instructions\` the implementer retries with, and \`context\`: the project file or fact the retry needs attached, or null. The brief is kept.
- \`rewrite-task\` — \`task\`: one complete replacement TaskSpec that fixes the brief itself.
- \`split-task\` — \`tasks\`: 2 or more complete TaskSpecs that together replace the task.
- \`verify\` — \`checkIds\` and \`reason\`: re-run exactly those checks before any retry, for when the failure may predate this task's own edits.
- ${ASK_USER_ACTION}
- ${CANNOT_ACTION}
- \`accept\` — \`note\`: a stuck review only. The remaining blockers need no more work; the note says why, and the user reads it before Apply.

The workspace rule: \`guidance\`, \`rewrite-task\` and \`split-task\` continue on the workspace as the failed attempt left it. The edits of the attempt stay, also its edits to files of earlier done tasks. A rewrite or a split names in its brief what to keep, change or remove of these edits.

The operator rule: the Operator Instructions are the user's own decisions for this task. No action undoes one of them. A question that concerns one of them quotes it, and its default keeps it.

The answer rule: SPLITBRIEF gives the user's answer to an \`ask-user\` question to the same implementer, as an instruction for its next attempt. An answer or an instruction of the user that asks you to decide is the user's consent to decide that matter yourself. An answer cannot change a seat's tool or model, buy credits, or wait for a limit to reset. Offer only choices that the next attempt can carry out. When the implementer cannot do the task at all, answer \`cannot\` and name the reason, for example a seat the user must change with \`/crew\`.

The criteria rule: a rewrite or a split never drops a criterion id; a split never splits a subtask. Every criterion id the task serves stays with its replacement, or with the union of the split tasks, and each replacement keeps a complete, verifiable brief. The checks rule: a defective check command may be repaired under the same check id, but a rewrite or a split never drops a check id that one of the task's criteria names; removing the requirement it checks needs \`ask-user\`. ${TASK_CMD_CHECK_RULE}`;

function consultContract(task: Task, writesFiles: ImplementerWriteMode): string {
  const role =
    task.fix === undefined
      ? "You are the run's planner."
      : "You are the run's planner. The review wrote this fix task for its findings, and you decide its repair.";
  const sizing = writesFiles === 'direct' ? ` ${DIRECT_WRITER_TASK_RULE}` : '';
  return `${role} ${CONSULT_CONTRACT_BODY}${sizing}`;
}

const RESUME_CONTRACT = `Answer again with exactly one JSON object in the consult shape: \`answer.diagnosis\` and exactly one action. The call stays read-only. ${GIT_READ_ONLY_RULE}. The operator rule still holds: no action undoes an operator instruction. The answer rule still holds: an answer only instructs the next attempt. Offer only choices that the next attempt can carry out. The workspace rule still holds: guidance, a rewrite and a split continue on the files the failed attempt left. A rewrite or a split names in its brief what to keep, change or remove of these edits. The criteria rule still holds: a rewrite or a split never drops a criterion id, and a split never splits a subtask. The checks rule still holds too: a defective check command may be repaired under the same check id, but removing a check id a served criterion names needs \`ask-user\`. The two actions that go to the user keep their limits:
- ${ASK_USER_ACTION}
- ${CANNOT_ACTION}`;

function reasonSection(input: ConsultPromptInput): PromptPart {
  return { heading: 'Reason', body: `${input.reason} — ${REASON_TEXT[input.reason]}` };
}

/** The user's own instructions for this brief; they outrank the brief where the two differ. */
function operatorInstructionsPart(input: ConsultPromptInput): PromptPart[] {
  if (input.operatorInstructions.length === 0) return [];
  return [
    {
      heading: 'Operator Instructions',
      body: [
        "The user gave these instructions for this task after the brief was written, oldest first. They are the user's own decisions and outrank the brief where the two differ.",
        '',
        ...input.operatorInstructions.map((text) => fenced(text)),
      ].join('\n'),
    },
  ];
}

/**
 * The consult prompt. A fresh session reads the whole prompt: the plan, the task and its
 * revisions, the attempt's evidence with the brief's history and the reason. A session that
 * still holds the planning thread is sent the short resumed turn instead: the task, the reason
 * and the new attempt's evidence with the brief's history.
 */
export function buildConsultPrompt(input: ConsultPromptInput): string {
  if (input.resumed === true) {
    return buildPrompt({
      title: 'Consult continued',
      intro: `The planner session already holds this run's plan and brief. ${input.task.id} needs another answer (reason: ${input.reason}).`,
      sections: [
        ...(input.plan === undefined
          ? []
          : [{ heading: 'Decisions', body: decisionLines(input.plan).join('\n') }]),
        {
          heading: 'Task',
          body: `**${input.task.id}** (revision ${input.task.revision ?? 1}) — ${input.task.title}`,
        },
        reasonSection(input),
        ...operatorInstructionsPart(input),
        ...attemptLines(input),
        instructionsSection(
          `${RESUME_CONTRACT}\n\n${workspaceReadInstructions(input.workspaceDir)}`,
        ),
      ],
    });
  }

  const sections: PromptPart[] = [];
  if (input.plan !== undefined) sections.push(planSection(input.plan));
  sections.push({
    heading: `Task ${input.task.id} (revision ${input.task.revision ?? 1})`,
    body: taskBody(input.task),
  });
  for (const revision of input.revisions) sections.push(revisionSection(revision));
  sections.push(reasonSection(input));
  sections.push(...operatorInstructionsPart(input));
  sections.push(...attemptLines(input));
  if (input.otherTasks.length > 0) {
    sections.push({ heading: 'Other Tasks', body: otherTaskLines(input.otherTasks).join('\n') });
  }
  sections.push(
    instructionsSection(
      `${consultContract(input.task, input.writesFiles)}\n\n${workspaceReadInstructions(input.workspaceDir)}`,
    ),
  );

  return buildPrompt({
    title: 'Consult on a failing task',
    intro: `One task of this run did not land, and SPLITBRIEF asks you to decide ${input.task.id}'s next step from the evidence below.`,
    sections,
  });
}
