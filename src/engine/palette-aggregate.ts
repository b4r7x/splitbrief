import { fuzzyMatchExtended } from '../utils/fuzzy-match.js';
import type { CommandPaletteItem } from '../core/slash-commands/types.js';

export type PaletteSource = 'slash' | 'mode' | 'picker' | 'task' | 'session' | 'custom';

export type PaletteResult = {
  id: string;
  label: string;
  description: string;
  source: PaletteSource;
  shortcut: string | null;
  score: number;
  mruRank: number;
  action: () => void;
};

export type PaletteInputs = {
  query: string;
  slashItems: CommandPaletteItem[];
  modeItems: Array<{ label: string; description: string; action: () => void }>;
  pickerItems: Array<{ label: string; description: string; action: () => void }>;
  taskItems: Array<{ id: string; title: string; action: () => void }>;
  sessionItems: Array<{ id: string; feature: string; status: string; action: () => void }>;
  customItems: Array<{ id: string; label: string; description: string; action: () => void }>;
  mruIds: string[];
};

type Candidate = Omit<PaletteResult, 'score' | 'mruRank'>;

type RankedPaletteResult = {
  result: PaletteResult;
  candidateOrder: number;
};

function buildCandidates(inputs: PaletteInputs): Candidate[] {
  const candidates: Candidate[] = [];

  for (const item of inputs.slashItems) {
    candidates.push({
      id: 'slash:' + item.label,
      label: item.label,
      description: item.description,
      source: 'slash',
      shortcut: item.shortcut ?? null,
      action: item.action,
    });
  }

  for (const item of inputs.modeItems) {
    candidates.push({
      id: 'mode:' + item.label,
      label: item.label,
      description: item.description,
      source: 'mode',
      shortcut: null,
      action: item.action,
    });
  }

  for (const item of inputs.pickerItems) {
    candidates.push({
      id: 'picker:' + item.label,
      label: item.label,
      description: item.description,
      source: 'picker',
      shortcut: null,
      action: item.action,
    });
  }

  for (const item of inputs.taskItems) {
    candidates.push({
      id: 'task:' + item.id,
      label: item.title,
      description: 'Task ' + item.id,
      source: 'task',
      shortcut: null,
      action: item.action,
    });
  }

  for (const item of inputs.sessionItems) {
    candidates.push({
      id: 'session:' + item.id,
      label: item.feature,
      description: item.status,
      source: 'session',
      shortcut: null,
      action: item.action,
    });
  }

  for (const item of inputs.customItems) {
    candidates.push({
      id: 'custom:' + item.id,
      label: item.label,
      description: item.description ?? '',
      source: 'custom',
      shortcut: null,
      action: item.action,
    });
  }

  return candidates;
}

function getMruRank(mruIds: string[], id: string): number {
  const index = mruIds.indexOf(id);
  return index >= 0 ? index + 1 : 0;
}

function compareRankedPaletteResults(a: RankedPaletteResult, b: RankedPaletteResult): number {
  const aMru = a.result.mruRank > 0;
  const bMru = b.result.mruRank > 0;

  if (aMru && !bMru) return -1;
  if (!aMru && bMru) return 1;

  if (aMru && bMru) {
    if (a.result.mruRank !== b.result.mruRank) return a.result.mruRank - b.result.mruRank;
    const labelCompare = a.result.label.localeCompare(b.result.label);
    return labelCompare !== 0 ? labelCompare : a.candidateOrder - b.candidateOrder;
  }

  if (b.result.score !== a.result.score) return b.result.score - a.result.score;

  if (a.result.score === 0 && b.result.score === 0) {
    return a.candidateOrder - b.candidateOrder;
  }

  const labelCompare = a.result.label.localeCompare(b.result.label);
  return labelCompare !== 0 ? labelCompare : a.candidateOrder - b.candidateOrder;
}

function sortPaletteResults(results: RankedPaletteResult[]): PaletteResult[] {
  return [...results].sort(compareRankedPaletteResults).map((ranked) => ranked.result);
}

export function buildPaletteResults(inputs: PaletteInputs): PaletteResult[] {
  const candidates = buildCandidates(inputs);
  const terms = inputs.query.trim();

  if (terms === '') {
    return sortPaletteResults(
      candidates.map((c, candidateOrder) => ({
        result: {
          ...c,
          score: 0,
          mruRank: getMruRank(inputs.mruIds, c.id),
        },
        candidateOrder,
      })),
    );
  }

  const scored: RankedPaletteResult[] = [];

  for (const [candidateOrder, c] of candidates.entries()) {
    const target = [c.label, c.description, c.source].join(' ');
    const result = fuzzyMatchExtended(terms, target);
    if (result === null) continue;
    scored.push({
      result: {
        ...c,
        score: result.score,
        mruRank: getMruRank(inputs.mruIds, c.id),
      },
      candidateOrder,
    });
  }

  return sortPaletteResults(scored);
}
