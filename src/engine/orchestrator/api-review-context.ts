import { DRIFT_REPORT_FILE, EVIDENCE_FILE, SPEC_FILE, TASKS_FILE } from '../../core/paths.js';
import { plannerStepsFor } from '../../core/pipeline-spec/steps.js';
import type { WorkflowMode } from '../../core/schemas/enums.js';
import { estimateTokens } from '../../core/tokens/estimate.js';
import { apiPlanningInputBudget, type ApiContextManifestEntry } from '../planners/api-context.js';
import { buildFinalReviewPrompt } from '../spec/prompts/review.js';

/** The packet's own names for the sections that are no file of their own. */
const RUN_DIFF = 'run diff';
const CHANGED_FILES = 'changed files';
const FEATURE_REQUEST = 'feature request';
const QUEUED_MESSAGES = 'queued messages';

const NO_TOOLS_NOTICE =
  'Everything SPLITBRIEF read for this review is reproduced in this prompt: the whole run diff, untruncated, every planning artifact and the recorded validation output. You have no filesystem, shell or search tool on this call — a file whose diff is not below was not read, and nothing about its contents may be assumed or claimed.';

/** What stands in for a specification in a mode that writes none. */
const SUBSTITUTED_REQUEST =
  'This run’s mode writes no specification. The original feature request below is the requirement this implementation is measured against.';

/** The ledger's own record that nothing ran, which is evidence, not absence. */
const NO_VALIDATION_RECORDED =
  'Recorded commands: none. This run’s evidence ledger contains no test, typecheck or lint stage, so there is no validation result to quote. Report validation as not run, and never assert a result the record does not contain.';

// A path with a space is spelled plainly; one with a non-ASCII or control byte
// is C-quoted, and a coverage check that could not read it would refuse a file
// the diff does carry.
const DIFF_HEADER_RE = /^diff --git (?:a\/(.+) b\/(.+)|"a\/(.+)" "b\/(.+)")$/m;
const BINARY_BODY_RE = /^(?:Binary files .* differ|GIT binary patch)$/m;
const OCTAL_ESCAPE_RE = /\\([0-7]{3})/g;
const LITERAL_ESCAPE_RE = /\\([\\"])/g;

/** The path a C-quoted header names, back in the spelling git status uses. */
function unquoteHeaderPath(raw: string): string {
  const bytes = raw
    .replace(LITERAL_ESCAPE_RE, '$1')
    .replace(OCTAL_ESCAPE_RE, (_, digits: string) =>
      String.fromCharCode(Number.parseInt(digits, 8)),
    );
  return Buffer.from(bytes, 'latin1').toString('utf8');
}

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
  /** The run's own mode, which decides whether a spec is a required artifact. */
  mode: WorkflowMode;
  /** The original request, which quick mode reviews in place of a spec. */
  feature: string;
  spec: string;
  taskBriefs: string;
  /** The run universe's whole diff. This seat is never given a cut one. */
  fullDiff: string;
  changedFiles: readonly string[];
  /** What the run started from, so a pre-run change stays distinguishable. */
  baseline: Readonly<{ head: string | null; runStartChangedFiles: readonly string[] }>;
  /** This review's freshly computed drift, or undefined when it has none. */
  driftSection: string | undefined;
  /** Whether the ledger was read at all, beside what it recorded. */
  validation: Readonly<{ recorded: boolean; evidence: string | undefined }>;
  queueText?: string | undefined;
  /** The reviewer seat's configured window; its allocation is derived from it. */
  contextLength?: number | undefined;
  model?: string | undefined;
}>;

type Part = { name: string; body: string };

/** What the run diff actually carries, by path, and what it cannot show. */
function readDiffCoverage(diff: string): { covered: Set<string>; binary: Set<string> } {
  const covered = new Set<string>();
  const binary = new Set<string>();
  for (const section of diff.split(/^(?=diff --git )/m)) {
    const header = DIFF_HEADER_RE.exec(section);
    if (header === null) continue;
    const quoted = header[1] === undefined;
    const before = quoted ? unquoteHeaderPath(header[3] ?? '') : (header[1] ?? '');
    const after = quoted ? unquoteHeaderPath(header[4] ?? '') : (header[2] ?? '');
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
      ? 'Run baseline: the project had no commit when this run started, so the whole working tree is what it changed.'
      : `Run baseline: commit ${input.baseline.head}. Every change below is measured against it.`,
    '',
    input.changedFiles.length === 0
      ? 'Files changed in this run: none.'
      : `Files changed in this run (${input.changedFiles.length}):`,
  ];
  for (const path of input.changedFiles) {
    lines.push(
      preRun.has(path) ? `- ${path} — already modified before this run started` : `- ${path}`,
    );
  }
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
 * it, the spec (or, in a mode that writes none, the original request), every
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

  // A mode that writes no spec is reviewed against the request it was given;
  // one that writes a spec is not reviewable without it.
  const specRequired = plannerStepsFor(input.mode, 'all').some(
    (step) => step.artifact === SPEC_FILE,
  );
  let spec = '';
  if (specRequired || input.spec.trim() !== '') {
    spec = required(SPEC_FILE, input.spec);
  } else {
    manifest.push({ path: SPEC_FILE, kind: 'optional', state: 'missing' });
    // Named for what it is: the substitute is never passed off as a spec.
    const request = required(FEATURE_REQUEST, input.feature);
    spec = request === '' ? '' : `${SUBSTITUTED_REQUEST}\n\n${request}`;
  }

  const taskBriefs = required(TASKS_FILE, input.taskBriefs);

  // A change the diff cannot show is a change this seat cannot review.
  const { covered, binary } = readDiffCoverage(input.fullDiff);
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
  parts.push({ name: RUN_DIFF, body: input.fullDiff });

  const coverage = coverageBody(input);
  manifest.push({ path: CHANGED_FILES, kind: 'required', state: 'included' });
  parts.push({ name: CHANGED_FILES, body: coverage });

  const drift = required(DRIFT_REPORT_FILE, input.driftSection ?? '');
  // The ledger's own record that nothing ran is complete evidence of a skipped
  // check; a ledger nobody could read is not.
  const validation = required(
    EVIDENCE_FILE,
    input.validation.recorded ? (input.validation.evidence ?? NO_VALIDATION_RECORDED) : '',
  );

  const queueText = input.queueText ?? '';
  if (queueText !== '') parts.push({ name: QUEUED_MESSAGES, body: queueText });

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
    diff: input.fullDiff,
    changeCoverage: coverage,
    driftReport: drift,
    validationEvidence: validation,
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
