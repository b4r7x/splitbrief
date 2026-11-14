import { formatContextLength } from '../../../core/formatting.js';
import { UNSET_EFFORT_WORD } from '../../../core/runners/effort-channel.js';
import { type RunnerBillingPosture, billingWord } from '../../../core/runners/runner-billing.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { truncateTerminalDisplayText } from '../../../utils/display-text/truncate.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { countNoun } from '../../../utils/pluralize.js';
import {
  parseOptionSelection,
  optionAxesOf,
  formatAxisValue,
} from '../model-catalog/option-axis.js';
import type { ModelOption } from '../model-catalog/recency.js';
import { CATALOG_LANE_PENDING, CATALOG_FETCH_FAILED } from '../model-catalog/rows.js';
import { effortLadderFor } from '../model-catalog/axis-rows.js';
import type { CatalogLane } from '../model-catalog/types.js';
import {
  type ModelCatalogDiagnostic,
  isDetectionNotRun,
  DETECT_RETRY,
  formatCatalogDiagnostic,
  commandFailedCopy,
} from './catalog-guidance.js';

// Detection has not run *and* the panel beside the byline is listing rows: those rows are the
// bundled list, so the byline names which list the user is reading instead of denying it exists.
const BUNDLED_LIST = 'Bundled model list';

/** A sentence broken on words into at most `maxLines` lines of `cells`; `cut` when words are left over. */
export function wrapOnWords(
  sentence: string,
  cells: number,
  maxLines: number,
): Readonly<{ lines: string[]; cut: boolean }> {
  const lines: string[] = [];
  let line = '';
  for (const word of sentence.split(' ')) {
    const next = line === '' ? word : `${line} ${word}`;
    if (line !== '' && getTerminalCellWidth(next) > cells) {
      lines.push(line);
      if (lines.length === maxLines) return { lines, cut: true };
      line = word;
      continue;
    }
    line = next;
  }
  return { lines: line === '' ? lines : [...lines, line], cut: false };
}

function laneStatus(lane: CatalogLane): string | undefined {
  if (lane === 'pending') return CATALOG_LANE_PENDING;
  if (lane === 'failed') return `${CATALOG_FETCH_FAILED}${SOFT_SEP}ctrl+r`;
  return undefined;
}

/**
 * The byline sheds its least useful fact first so the billing word is the last segment standing:
 * capability words, then the version the tool row already prints, then the clause that qualifies
 * the source, then the provenance itself.
 */
function fitToolsByline(input: {
  toolName: string;
  version: string | undefined;
  count: string;
  provenance: string | undefined;
  trust: string | undefined;
  capabilities: readonly string[];
  billing: string | undefined;
  budget: number;
}): string {
  const compose = (kept: number, version: boolean, trust: boolean, provenance: boolean): string =>
    [
      input.toolName,
      version ? input.version : undefined,
      input.count,
      provenance ? input.provenance : undefined,
      provenance && trust ? input.trust : undefined,
      ...input.capabilities.slice(0, kept),
      input.billing,
    ]
      .filter((part): part is string => part !== undefined)
      .join(SOFT_SEP);
  const rungs: string[] = [];
  for (let kept = input.capabilities.length; kept >= 0; kept--) {
    rungs.push(compose(kept, true, true, true));
  }
  rungs.push(compose(0, false, true, true));
  rungs.push(compose(0, false, false, true));
  const floor = compose(0, false, false, false);
  return rungs.find((line) => getTerminalCellWidth(line) <= input.budget) ?? floor;
}

/** The catalog status the byline must show whichever column has focus, or undefined when there is none. */
export function bylineDiagnostic(input: {
  diagnostic: ModelCatalogDiagnostic | undefined;
  modelCount: number;
  toolName: string;
  budget: number;
}): string | undefined {
  const { diagnostic } = input;
  if (diagnostic === undefined) return undefined;
  // An alias lane by design is not a failure: claude-code lists rows and still reports `unsupported`.
  if (input.modelCount > 0 && diagnostic.kind === 'unsupported') return undefined;
  // Rows are listed and detection has not run: they are the bundled list. Saying detection has not
  // run would contradict the column beside it, so name the list the user is reading instead.
  if (input.modelCount > 0 && isDetectionNotRun(diagnostic)) {
    return `${BUNDLED_LIST}${DETECT_RETRY}`;
  }
  if (diagnostic.kind !== 'probe-failed' || diagnostic.failure !== 'command-failed') {
    return formatCatalogDiagnostic(diagnostic, input.toolName);
  }
  let causeCells = getTerminalCellWidth(diagnostic.cause);
  let fitted = commandFailedCopy(input.toolName, diagnostic.cause);
  while (causeCells > 0 && wrapOnWords(fitted, input.budget, 2).cut) {
    causeCells -= 1;
    fitted = commandFailedCopy(
      input.toolName,
      truncateTerminalDisplayText(diagnostic.cause, causeCells),
    );
  }
  return fitted;
}

/**
 * The Tools column answers for the tool. A catalog diagnostic is the whole line: it measures more
 * than the panel is wide, so there is nothing it could be joined to.
 */
export function formatToolsByline(input: {
  toolName: string;
  version: string | undefined;
  modelCount: number;
  rowNoun: string;
  rowNounPlural: string;
  source: string | undefined;
  unverifiedForPlan: boolean;
  diagnostic: ModelCatalogDiagnostic | undefined;
  lane: CatalogLane;
  capabilities: readonly string[];
  billing: RunnerBillingPosture;
  budget: number;
}): string {
  const status = bylineDiagnostic({
    diagnostic: input.diagnostic,
    modelCount: input.modelCount,
    toolName: input.toolName,
    budget: input.budget,
  });
  if (status !== undefined) return status;

  const lane = laneStatus(input.lane);
  const provenance = lane ?? input.source;
  // The lane status replaces the source, so a lane that is not ready carries no trust clause.
  const trust =
    lane === undefined && input.unverifiedForPlan ? 'not verified for your plan' : undefined;
  return fitToolsByline({
    toolName: input.toolName,
    version: input.version,
    count: countNoun(input.modelCount, input.rowNoun, input.rowNounPlural),
    provenance,
    trust,
    capabilities: input.capabilities,
    billing: billingWord(input.billing),
    budget: input.budget,
  });
}

/**
 * The Models column answers for the highlighted row: its label, its exact id, what it has chosen,
 * its size — and, where its listing says so, that it takes no tool calls, which a seat's agent
 * loop runs on.
 */
export function formatModelsByline(input: {
  label: string;
  id: string;
  axes: readonly string[];
  contextLength: number | undefined;
  supportsToolCalls?: boolean | undefined;
  autoRow?: { toolName: string } | undefined;
}): string {
  if (input.autoRow !== undefined) {
    return [input.label, 'no --model flag', `${input.autoRow.toolName} runs its own default`].join(
      SOFT_SEP,
    );
  }
  const parts = [input.label];
  if (input.id !== '' && input.id !== input.label) parts.push(input.id);
  parts.push(...input.axes);
  const size = formatContextLength(input.contextLength);
  if (size !== '') parts.push(size);
  if (input.supportsToolCalls === false) parts.push('no tool calls');
  return parts.join(SOFT_SEP);
}

/**
 * The ladder is the authoritative effort where a route publishes one; the id's tokens are not a
 * second one, and an axis the row has not moved from its default states nothing. The words are the
 * ones `formatSeatIdentity` states — bare, unlabelled — so the byline and the seat identity spell
 * one selection one way.
 */
export function modelBylineAxes(input: {
  model: ModelOption;
  id: string;
  effortDraft: string | null;
}): string[] {
  const variants = input.model.variants ?? [];
  const providerPrefix =
    variants.find((variant) => variant.fullId === input.id)?.providerPrefix ?? '';
  const ladder = effortLadderFor(input.model, input.id);
  const selection = parseOptionSelection(input.id);
  const words: string[] = [];
  const draft = input.effortDraft ?? '';
  if (ladder.length > 0 && ladder.includes(draft)) words.push(draft);
  for (const axis of optionAxesOf(variants, providerPrefix)) {
    if (axis.axis === 'effort') {
      if (ladder.length > 0) continue;
      if (selection.effort !== UNSET_EFFORT_WORD) words.push(selection.effort);
      continue;
    }
    if (formatAxisValue(axis.axis, selection) === 'on') words.push(axis.axis);
  }
  return words;
}
