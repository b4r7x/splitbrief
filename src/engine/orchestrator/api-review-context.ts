import type { TriageInput } from '../../core/schemas/review.js';
import { DRIFT_REPORT_FILE, EVIDENCE_FILE, SPEC_FILE, TASKS_FILE } from '../../core/paths.js';
import { estimateTokens } from '../../core/tokens/estimate.js';
import { splitDiffByFile } from '../../lib/git/diff-sections.js';
import { apiPlanningInputBudget, type ApiContextManifestEntry } from '../planners/api-context.js';
import { renderWholeChecksLog } from './evidence/review-packet/render.js';
import {
  buildFinalReviewPrompt,
  reviewInputsSection,
  type ReviewPlanData,
  type ReviewFileDiff,
  type ReviewTouchedNotSuggested,
} from '../spec/prompts/review.js';

/** The packet's own names for the sections that are no file of their own. */
const RUN_DIFF = 'run diff';
const CHANGED_FILES = 'changed files';
const FEATURE_REQUEST = 'feature request';
const QUEUED_MESSAGES = 'queued messages';
const SKILLS = 'skills';

const NO_TOOLS_NOTICE =
  'Everything SPLITBRIEF read for this review is reproduced in this prompt: the whole run diff, untruncated, every planning artifact and the recorded validation output. You have no filesystem, shell or search tool on this call — a file whose diff is not below was not read, and nothing about its contents may be assumed or claimed.';

/** What stands in for a specification in a run that wrote none. */
const SUBSTITUTED_REQUEST =
  'This run wrote no specification. The original feature request below is the requirement this implementation is measured against.';

const BINARY_BODY_RE = /^(?:Binary files .* differ|GIT binary patch)$/m;

export type ApiReviewContext =
  | Readonly<{
      kind: 'complete';
      text: string;
      manifest: readonly ApiContextManifestEntry[];
    }>
  | Readonly<{
      kind: 'insufficient-context';
      cause: 'missing-required' | 'unsupported-required' | 'input-budget';
      missingSections: readonly string[];
      requiredTokens: number;
      availableTokens: number;
      manifest: readonly ApiContextManifestEntry[];
    }>;

export type ApiReviewContextInput = Readonly<{
  /** The original request, which a run without a spec is reviewed against. */
  feature: string;
  pendingInputs: readonly TriageInput[];
  fixCycle: number;
  spec: string;
  taskBriefs: string;
  reviewKind?: 'task' | 'final' | undefined;
  /** The run universe's whole diff. This seat is never given a cut one. */
  fullDiff: string;
  changedFiles: readonly string[];
  /** What the run started from, so a pre-run change stays distinguishable. */
  baseline: Readonly<{ head: string | null; runStartChangedFiles: readonly string[] }>;
  /** This review's freshly computed drift, or undefined when it has none. */
  driftSection: string | undefined;
  /** Whether the ledger was read at all, beside what it recorded. */
  validation: Readonly<{ recorded: boolean; evidence: string | undefined }>;
  reviewScope?:
    | Readonly<{
        files: readonly ReviewFileDiff[];
        laterDiff: string;
        workspaceContext: readonly ReviewFileDiff[];
        description: string;
      }>
    | undefined;
  queueText?: string | undefined;
  /** The ids the verdict must answer for, as the prompt's Required Results states them. */
  taskIds?: readonly string[] | undefined;
  criterionIds?: readonly string[] | undefined;
  /** The plan as data: the criteria with their checks, and the briefs. */
  plan?: ReviewPlanData | undefined;
  touchedNotSuggested?: readonly ReviewTouchedNotSuggested[] | undefined;
  checkResults?: string | undefined;
  consultLog?: string | undefined;
  triageLog?: string | undefined;
  planningAnswers?: string | undefined;
  operatorInstructions?: string | undefined;
  /** The render scenarios the checks log recorded, attached or as a manifest. */
  renders?: string | undefined;
  /** The run's skills block; counted against the seat like every other part it carries. */
  skillsContext?: string | undefined;
  /** The reviewer seat's configured window; its allocation is derived from it. */
  contextLength?: number | undefined;
  model?: string | undefined;
}>;

type Part = { name: string; body: string };

/** What the run diff actually carries, by path, and what it cannot show. */
function readDiffCoverage(diff: string): { covered: Set<string>; binary: Set<string> } {
  const covered = new Set<string>();
  const binary = new Set<string>();
  for (const { before, after, diff: section } of splitDiffByFile(diff)) {
    covered.add(before);
    covered.add(after);
    if (BINARY_BODY_RE.test(section)) binary.add(after);
  }
  return { covered, binary };
}

function coverageBody(input: ApiReviewContextInput): string {
  const preRun = new Set(input.baseline.runStartChangedFiles);
  const lines = [
    input.baseline.head === null
      ? 'Workspace comparison: the project had no commit when this run started.'
      : `Workspace comparison: commit ${input.baseline.head}. This comparison alone does not establish authorship.`,
    '',
    input.changedFiles.length === 0
      ? 'Workspace comparison files: none.'
      : `Workspace comparison files (${input.changedFiles.length}):`,
  ];
  for (const path of input.changedFiles) {
    lines.push(
      preRun.has(path) ? `- ${path} — already modified before this run started` : `- ${path}`,
    );
  }
  if (input.reviewScope !== undefined) lines.push('', input.reviewScope.description);
  lines.push('', NO_TOOLS_NOTICE);
  return lines.join('\n');
}

/**
 * The sections that do not fit, in assembly order: everything from the first one
 * that pushes the total past the allocation. Required material is never cut down
 * to be admitted — it is named as not fitting.
 */
function overflowing(parts: readonly Part[], availableTokens: number, model?: string): string[] {
  const names: string[] = [];
  let used = 0;
  for (const part of parts) {
    const tokens = estimateTokens(part.body, model);
    if (names.length === 0 && used + tokens <= availableTokens) {
      used += tokens;
      continue;
    }
    if (!names.includes(part.name)) names.push(part.name);
  }
  return names;
}

/**
 * The §4 REVIEW input packet: the whole run diff with the coverage that bounds
 * it, the spec (or, in a run that wrote none, the original request), every
 * task brief, this review's own drift and the recorded validation output. Every
 * one of them is required, so the packet either carries all of them whole or
 * refuses — it is never a success packet with a source missing from it, and no
 * part of it is truncated to be admitted.
 */
export function buildApiReviewContext(input: ApiReviewContextInput): ApiReviewContext {
  const { model } = input;
  const availableTokens = apiPlanningInputBudget(input.contextLength);
  const manifest: ApiContextManifestEntry[] = [];
  const missingSections: string[] = [];
  const parts: Part[] = [];

  const required = (name: string, body: string): string => {
    if (body.trim() === '') {
      manifest.push({ path: name, kind: 'required', state: 'missing' });
      missingSections.push(name);
      return '';
    }
    manifest.push({ path: name, kind: 'required', state: 'included' });
    parts.push({ name, body });
    return body;
  };

  // A run that wrote a spec is reviewed against it; one that wrote none, against the request it
  // was given.
  let spec = '';
  if (input.spec.trim() !== '') {
    spec = required(SPEC_FILE, input.spec);
  } else {
    manifest.push({ path: SPEC_FILE, kind: 'optional', state: 'missing' });
    // Named for what it is: the substitute is never passed off as a spec.
    const request = required(FEATURE_REQUEST, input.feature);
    spec = request === '' ? '' : `${SUBSTITUTED_REQUEST}\n\n${request}`;
  }

  const taskBriefs = required(TASKS_FILE, input.taskBriefs);
  if (input.skillsContext !== undefined) parts.push({ name: SKILLS, body: input.skillsContext });

  // A change the diff cannot show is a change this seat cannot review.
  const { covered, binary } = readDiffCoverage(input.fullDiff);
  const recordedDiff = input.reviewScope?.files.map((file) => file.diff).join('\n') ?? '';
  for (const path of readDiffCoverage(recordedDiff).binary) binary.add(path);
  for (const path of binary) {
    manifest.push({ path, kind: 'required', state: 'unsupported' });
    missingSections.push(path);
  }
  for (const path of input.changedFiles) {
    if (binary.has(path)) continue;
    const state = covered.has(path) ? 'included' : 'missing';
    manifest.push({ path, kind: 'required', state });
    if (state === 'missing') missingSections.push(path);
  }

  // An empty diff is the whole truth of a run that changed nothing; it is a
  // missing source only when a file the run universe names is absent from it.
  manifest.push({ path: RUN_DIFF, kind: 'required', state: 'included' });
  parts.push({
    name: RUN_DIFF,
    body: input.reviewScope?.workspaceContext.map((file) => file.diff).join('\n') ?? input.fullDiff,
  });
  if (input.reviewScope !== undefined) {
    manifest.push({ path: 'recorded promotions', kind: 'required', state: 'included' });
    parts.push({
      name: 'recorded promotions',
      body: [recordedDiff, input.reviewScope.laterDiff].filter(Boolean).join('\n'),
    });
  }

  const coverage = coverageBody(input);
  manifest.push({ path: CHANGED_FILES, kind: 'required', state: 'included' });
  parts.push({ name: CHANGED_FILES, body: coverage });

  const drift = required(DRIFT_REPORT_FILE, input.driftSection ?? '');
  // The ledger's own record that nothing ran is complete evidence of a skipped
  // check; a ledger nobody could read is not.
  const checksLog = required(
    EVIDENCE_FILE,
    input.validation.recorded
      ? (input.validation.evidence ?? renderWholeChecksLog({ entries: [], outsideReadPaths: [] }))
      : '',
  );

  const queueText = input.queueText ?? '';
  if (queueText !== '') parts.push({ name: QUEUED_MESSAGES, body: queueText });
  if (input.pendingInputs.length > 0) {
    required('pending inputs', reviewInputsSection(input.pendingInputs));
  }

  if (missingSections.length > 0) {
    return {
      kind: 'insufficient-context',
      cause: binary.size > 0 ? 'unsupported-required' : 'missing-required',
      missingSections,
      requiredTokens: parts.reduce((sum, part) => sum + estimateTokens(part.body, model), 0),
      availableTokens,
      manifest,
    };
  }

  const prompt = buildFinalReviewPrompt({
    spec,
    taskBriefs,
    reviewKind: input.reviewKind,
    pendingInputs: input.pendingInputs,
    fixCycle: input.fixCycle,
    ...(input.reviewScope === undefined
      ? { diff: input.fullDiff }
      : {
          files: input.reviewScope.files,
          laterDiff: input.reviewScope.laterDiff,
          workspaceContext: input.reviewScope.workspaceContext,
        }),
    ...(input.plan !== undefined && { plan: input.plan }),
    ...(input.touchedNotSuggested !== undefined && {
      touchedNotSuggested: input.touchedNotSuggested,
    }),
    ...(input.checkResults !== undefined && { checkResults: input.checkResults }),
    ...(input.consultLog !== undefined && { consultLog: input.consultLog }),
    ...(input.triageLog !== undefined && { triageLog: input.triageLog }),
    ...(input.planningAnswers !== undefined && { planningAnswers: input.planningAnswers }),
    ...(input.operatorInstructions !== undefined && {
      operatorInstructions: input.operatorInstructions,
    }),
    ...(input.renders !== undefined && { renders: input.renders }),
    ...(input.taskIds !== undefined && { taskIds: input.taskIds }),
    ...(input.criterionIds !== undefined && { criterionIds: input.criterionIds }),
    changeCoverage: coverage,
    driftReport: drift,
    checksLog,
    skillsContext: input.skillsContext,
  });
  const text = queueText + prompt;
  // Measured on the payload the seat will actually dispatch, whole.
  const requiredTokens = estimateTokens(text, model);
  if (requiredTokens > availableTokens) {
    const names = overflowing(parts, availableTokens, model);
    return {
      kind: 'insufficient-context',
      cause: 'input-budget',
      missingSections: names,
      requiredTokens,
      availableTokens,
      manifest: manifest.map((entry) =>
        names.includes(entry.path) ? { ...entry, state: 'omitted' } : entry,
      ),
    };
  }
  return { kind: 'complete', text, manifest };
}
