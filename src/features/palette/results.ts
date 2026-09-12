import { fuzzyMatchExtended } from './fuzzy-match.js';
import { COMMAND_CATEGORIES } from '../../core/runtime/commands/types.js';
import type { CommandCategory } from '../../core/runtime/commands/types.js';

export type PaletteSource = 'command' | 'task' | 'session' | 'custom';

export type PaletteAction =
  | { kind: 'run'; run: () => void | Promise<void> }
  | { kind: 'prefill'; text: string };

export interface PaletteCommandItem {
  label: string;
  description: string;
  /** The argument grammar, carried apart from the description so a row can drop it whole. */
  hint: string | null;
  shortcut: string | null;
  category: CommandCategory;
  action: PaletteAction;
}

interface PaletteCandidateBase {
  id: string;
  label: string;
  description: string;
  hint: string | null;
  shortcut: string | null;
  action: PaletteAction;
}

// Only command rows carry a category; the discriminant lets a `category === null` check narrow a
// row to the sources that need a source-name header.
type PaletteCandidate = PaletteCandidateBase &
  (
    | { source: 'command'; category: CommandCategory }
    | { source: Exclude<PaletteSource, 'command'>; category: null }
  );

export type PaletteResult = PaletteCandidate & { score: number; mruRank: number };

type PaletteItemAction = { action: () => void | Promise<void> };

export type PaletteInputs = {
  query: string;
  commandItems: PaletteCommandItem[];
  taskItems: Array<{ id: string; title: string } & PaletteItemAction>;
  sessionItems: Array<{ id: string; feature: string; status: string } & PaletteItemAction>;
  customItems: Array<{ id: string; label: string; description: string } & PaletteItemAction>;
  mruIds: string[];
};

type RankedPaletteResult = {
  result: PaletteResult;
  candidateOrder: number;
};

function buildCandidates(inputs: PaletteInputs): PaletteCandidate[] {
  const candidates: PaletteCandidate[] = [];

  for (const item of inputs.commandItems) {
    candidates.push({
      id: 'command:' + item.label,
      label: item.label,
      description: item.description,
      hint: item.hint,
      source: 'command',
      category: item.category,
      shortcut: item.shortcut,
      action: item.action,
    });
  }

  for (const item of inputs.taskItems) {
    candidates.push({
      id: 'task:' + item.id,
      label: item.title,
      description: 'task ' + item.id,
      hint: null,
      source: 'task',
      category: null,
      shortcut: null,
      action: { kind: 'run', run: item.action },
    });
  }

  for (const item of inputs.sessionItems) {
    candidates.push({
      id: 'session:' + item.id,
      label: item.feature,
      description: item.status,
      hint: null,
      source: 'session',
      category: null,
      shortcut: null,
      action: { kind: 'run', run: item.action },
    });
  }

  for (const item of inputs.customItems) {
    candidates.push({
      id: 'custom:' + item.id,
      label: item.label,
      description: item.description,
      hint: null,
      source: 'custom',
      category: null,
      shortcut: null,
      action: { kind: 'run', run: item.action },
    });
  }

  return candidates;
}

function getMruRank(mruIds: string[], id: string): number {
  const index = mruIds.indexOf(id);
  return index >= 0 ? index + 1 : 0;
}

function categoryOrder(result: PaletteResult): number {
  if (result.category === null) return COMMAND_CATEGORIES.length;
  return COMMAND_CATEGORIES.indexOf(result.category);
}

function compareByMru(a: RankedPaletteResult, b: RankedPaletteResult): number | null {
  const aMru = a.result.mruRank > 0;
  const bMru = b.result.mruRank > 0;

  if (aMru !== bMru) return aMru ? -1 : 1;
  if (!aMru) return null;

  if (a.result.mruRank !== b.result.mruRank) return a.result.mruRank - b.result.mruRank;
  const labelCompare = a.result.label.localeCompare(b.result.label);
  return labelCompare !== 0 ? labelCompare : a.candidateOrder - b.candidateOrder;
}

// An empty query is a browse view of the whole registry, so category order alone decides it:
// floating an MRU row out of its category would emit that category's header a second time.
function compareByCategory(a: RankedPaletteResult, b: RankedPaletteResult): number {
  const categoryCompare = categoryOrder(a.result) - categoryOrder(b.result);
  return categoryCompare !== 0 ? categoryCompare : a.candidateOrder - b.candidateOrder;
}

function compareByScore(a: RankedPaletteResult, b: RankedPaletteResult): number {
  const mru = compareByMru(a, b);
  if (mru !== null) return mru;

  if (b.result.score !== a.result.score) return b.result.score - a.result.score;
  const labelCompare = a.result.label.localeCompare(b.result.label);
  return labelCompare !== 0 ? labelCompare : a.candidateOrder - b.candidateOrder;
}

function sortPaletteResults(
  results: RankedPaletteResult[],
  compare: (a: RankedPaletteResult, b: RankedPaletteResult) => number,
): PaletteResult[] {
  return [...results].sort(compare).map((ranked) => ranked.result);
}

export function buildPaletteResults(inputs: PaletteInputs): PaletteResult[] {
  const candidates = buildCandidates(inputs);
  const terms = inputs.query.trim();

  if (terms === '') {
    return sortPaletteResults(
      candidates.map((candidate, candidateOrder) => ({
        result: { ...candidate, score: 0, mruRank: getMruRank(inputs.mruIds, candidate.id) },
        candidateOrder,
      })),
      compareByCategory,
    );
  }

  const scored: RankedPaletteResult[] = [];

  for (const [candidateOrder, candidate] of candidates.entries()) {
    // The grammar is part of the target even though it is a cell of its own: typing `speckit`
    // still has to find `/mode`.
    const target = [candidate.label, candidate.description, candidate.hint ?? '', candidate.source]
      .filter((part) => part !== '')
      .join(' ');
    const match = fuzzyMatchExtended(terms, target);
    if (match === null) continue;
    scored.push({
      result: {
        ...candidate,
        score: match.score,
        mruRank: getMruRank(inputs.mruIds, candidate.id),
      },
      candidateOrder,
    });
  }

  // A section header marks a transition, not a group, so equal sections have to stay contiguous or
  // the same header is drawn several times. Sections lead with their best match; rows follow score.
  const sections = new Map<string, PaletteResult[]>();
  for (const result of sortPaletteResults(scored, compareByScore)) {
    const key = result.category ?? result.source;
    const section = sections.get(key);
    if (section === undefined) sections.set(key, [result]);
    else section.push(result);
  }
  return [...sections.values()].flat();
}
