import { useState } from 'react';
import { Fzf, type FzfResultItem } from 'fzf';
import { useCompletionSelection } from '../use-completion-selection.js';
import { useCompletionNavigation } from '../use-completion-navigation.js';

const MAX_RESULTS = 50;

const fzfCache = new WeakMap<string[], Fzf<string[]>>();

function getFzf(files: string[]): Fzf<string[]> {
  const cached = fzfCache.get(files);
  if (cached) return cached;
  const fzf = new Fzf(files);
  fzfCache.set(files, fzf);
  return fzf;
}

interface UseReferenceCompletionOptions {
  files: string[];
  value: string;
  setValue: (value: string) => void;
  disabled?: boolean | undefined;
  suppressed?: boolean | undefined;
}

interface UseReferenceCompletionResult {
  filtered: string[];
  selectedIndex: number;
  showSuggestions: boolean;
  inputKey: number;
}

interface ReferenceToken {
  start: number;
  query: string;
}

interface LatestReferenceState {
  value: string;
  token: ReferenceToken | null;
  selectionKey: string;
  itemCount: number;
  filtered: string[];
}

function isTokenBoundary(value: string, index: number): boolean {
  return index === 0 || value[index - 1] === ' ' || value[index - 1] === '\n';
}

function findReferenceToken(value: string): ReferenceToken | null {
  for (let i = value.length - 1; i >= 0; i--) {
    const char = value[i];
    if (char === '@') {
      if (isTokenBoundary(value, i)) {
        return { start: i, query: value.slice(i + 1) };
      }
      return null;
    }
    if (char === ' ' || char === '\n') return null;
  }
  return null;
}

function filterFiles(files: string[], query: string): string[] {
  if (!query) return files.slice(0, MAX_RESULTS);
  return getFzf(files)
    .find(query)
    .slice(0, MAX_RESULTS)
    .map((entry: FzfResultItem<string>) => entry.item);
}

function completeToken(value: string, token: ReferenceToken, selected: string): string {
  return `${value.slice(0, token.start)}@${selected}${value.slice(token.start + token.query.length + 1)}`;
}

function buildReferenceSelectionKey(token: ReferenceToken | null, filtered: string[]): string {
  if (!token) return '';
  return [token.start, token.query, filtered.join('\u0000')].join('\u0001');
}

export function useReferenceCompletion({
  files,
  value,
  setValue,
  disabled,
  suppressed,
}: UseReferenceCompletionOptions): UseReferenceCompletionResult {
  const [dismissedValue, setDismissedValue] = useState<string | null>(null);

  const token = findReferenceToken(value);
  const filtered = token ? filterFiles(files, token.query) : [];
  const showSuggestions =
    token !== null && filtered.length > 0 && dismissedValue !== value && !suppressed;
  const selectionKey = buildReferenceSelectionKey(token, filtered);
  const { effectiveSelectedIndex, latestRef, moveSelection } =
    useCompletionSelection<LatestReferenceState>({
      value,
      token,
      selectionKey,
      itemCount: filtered.length,
      filtered,
    });

  const { inputKey, bumpInputKey } = useCompletionNavigation({
    isActive: showSuggestions && !disabled,
    latestRef,
    hasItems: (l) => !!l.token && l.filtered.length > 0,
    onMove: (l, dir) => moveSelection(l, dir),
    onSelect: (l) => {
      const selected = l.filtered[l.effectiveSelectedIndex];
      if (selected && l.token) {
        const nextValue = completeToken(l.value, l.token, selected);
        setValue(nextValue);
        setDismissedValue(nextValue);
        bumpInputKey();
      }
    },
    onEscape: (l) => setDismissedValue(l.value),
  });

  return {
    filtered,
    selectedIndex: effectiveSelectedIndex,
    showSuggestions,
    inputKey,
  };
}
