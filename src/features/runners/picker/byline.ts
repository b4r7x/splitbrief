import { UNSET_EFFORT_WORD } from '../../../core/runners/effort-channel.js';
import { isCliToolId } from '../../../core/runners/cli-tool/catalog.js';
import { declaredCatalogProbe } from '../../../engine/runners/cli-tools/probe/catalog.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { ELLIPSIS } from '../../../utils/display-text/truncate.js';
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
  const words = diagnostic.cause.trim().split(/\s+/u);
  for (let kept = words.length; kept > 0; kept--) {
    const cause = words.slice(0, kept).join(' ') + (kept < words.length ? ELLIPSIS : '');
    const line = commandFailedCopy(input.toolName, cause);
    const wrapped = wrapOnWords(line, input.budget, 2);
    if (!wrapped.cut && wrapped.lines.every((row) => getTerminalCellWidth(row) <= input.budget))
      return line;
  }
  return commandFailedCopy(input.toolName, ELLIPSIS);
}

/**
 * The Tools column answers for the tool. A catalog diagnostic is the whole line: it measures more
 * than the panel is wide, so there is nothing it could be joined to.
 */
export function formatToolsByline(input: {
  toolName: string;
  version: string | undefined;
  modelCount: number;
  toolId: string;
  diagnostic: ModelCatalogDiagnostic | undefined;
  lane: CatalogLane;
  capabilities: readonly string[];
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
  const probe = isCliToolId(input.toolId) ? declaredCatalogProbe(input.toolId) : undefined;
  const count = probe?.kind === 'not-run' ? undefined : countNoun(input.modelCount, 'model');
  const compose = (version: string | undefined, capabilities: readonly string[]) =>
    [input.toolName, version, count, lane, ...capabilities].filter(Boolean).join(SOFT_SEP);
  for (let kept = input.capabilities.length; kept >= 0; kept--) {
    const line = compose(input.version, input.capabilities.slice(0, kept));
    if (getTerminalCellWidth(line) <= input.budget) return line;
  }
  return compose(undefined, []);
}

/**
 * The Models column names the highlighted label, model ID, axes, and tool-call support.
 */
export function formatModelsByline(input: {
  label: string;
  id: string;
  axes: readonly string[];
  supportsToolCalls?: boolean | undefined;
  autoRow?: { toolName: string } | undefined;
}): string {
  if (input.autoRow !== undefined) {
    return `${input.autoRow.toolName} chooses the model`;
  }
  const parts = [input.label];
  if (input.id !== '' && input.id !== input.label) parts.push(input.id);
  parts.push(...input.axes);
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
