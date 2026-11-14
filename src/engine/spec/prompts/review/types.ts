import type { TriageInput } from '../../../../core/schemas/review/verdict.js';
import type { ImplementerWriteMode } from '../../../../core/schemas/runner/implementer.js';

/** The plan's own data: the criteria and the briefs the verdict must answer for. */
export type ReviewPlanData = {
  criteria: readonly { id: string; text: string; checkIds: readonly string[] }[];
  /**
   * The decisions ledger: the plan's decisions, and with a task id the decisions that task's
   * implementer reported.
   */
  decisions?: readonly { text: string; taskId: string | null }[] | undefined;
  tasks: readonly {
    id: string;
    lineageId: string;
    status: 'done' | 'pending' | 'skipped';
    title: string;
    intent: string;
    steps: readonly string[];
    criteria: readonly string[];
    suggestedFiles: readonly string[];
    exclusions: readonly string[];
  }[];
};

export type ReviewFileDiff = { path: string; taskIds: readonly string[]; diff: string };

/** What a task wrote outside the set any brief suggested. */
export type ReviewTouchedNotSuggested = { taskId: string; files: readonly string[] };

export type ReviewChange = Pick<
  FinalReviewPromptInput,
  'diff' | 'files' | 'laterDiff' | 'workspaceContext'
>;

/** The change file a reviewer reads; `provenance` when its blocks name the tasks that changed each file. */
export type ReviewChangeFile = Readonly<{ path: string; provenance: boolean }>;

export type FinalReviewPromptInput = {
  spec: string;
  taskBriefs: string;
  reviewKind?: 'task' | 'final' | undefined;
  pendingInputs?: readonly TriageInput[] | undefined;
  fixCycle?: number | undefined;
  /** How the default implementer writes files: the fix tasks of a fix cycle are written for it. */
  writesFiles?: ImplementerWriteMode | undefined;
  /** The one-shot review diff, used only when files are undefined. */
  diff?: string | undefined;
  files?: readonly ReviewFileDiff[] | undefined;
  laterDiff?: string | undefined;
  workspaceContext?: readonly ReviewFileDiff[] | undefined;
  /** The file that holds the change, for a reviewer that reads it; replaces the diff sections. */
  changeFile?: ReviewChangeFile | undefined;
  trimmed?: string | undefined;
  /** The plan as data: the criteria with their checks, and the briefs. */
  plan?: ReviewPlanData | undefined;
  /** Per-task files the briefs did not suggest. */
  touchedNotSuggested?: readonly ReviewTouchedNotSuggested[] | undefined;
  /** The recorded check runs, one line per check id. */
  checkResults?: string | undefined;
  /** The run's consult records, in order. */
  consultLog?: string | undefined;
  /** The fix work, rejections and questions of each review cycle. */
  triageLog?: string | undefined;
  /** What the operator answered during planning. */
  planningAnswers?: string | undefined;
  /** Each brief's operator instructions: what the user told it after the plan was written. */
  operatorInstructions?: string | undefined;
  /** The ids the verdict must answer for; derived from `plan` when omitted. */
  taskIds?: readonly string[] | undefined;
  criterionIds?: readonly string[] | undefined;
  /** The ids a finding's checkIds may name; the prompt lists no check ids when omitted. */
  checkIds?: readonly string[] | undefined;
  driftReport?: string | undefined;
  checksLog?: string | undefined;
  /** The render scenarios the checks log recorded, attached or as a manifest. */
  renders?: string | undefined;
  /**
   * What the run changed and what the diff below covers. A seat that reads no
   * files of its own is told the scope it is judging instead of inferring it.
   */
  changeCoverage?: string | undefined;
  skillsContext?: string | undefined;
};
