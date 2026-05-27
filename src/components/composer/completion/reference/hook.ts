import { useState } from 'react';
import { useInput } from 'ink';
import { Fzf, type FzfResultItem } from 'fzf';
import { useCompletionSelection } from '../use-completion-selection.js';

const MAX_RESULTS = 50;

interface UseReferenceCompletionOptions {
  files: string[];
  value: string;
  setValue: (value: string) => void;
  disabled?: boolean | undefined;
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

export function findReferenceToken(value: string): ReferenceToken | null {
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
  const fzf = new Fzf(files);
  return fzf.find(query).slice(0, MAX_RESULTS).map((entry: FzfResultItem<string>) => entry.item);
}

function completeToken(value: string, token: ReferenceToken, selected: string): string {
  return `${value.slice(0, token.start)}@${selected}${value.slice(token.start + token.query.length + 1)}`;
}

function buildSelectionKey(token: ReferenceToken | null, filtered: string[]): string {
  if (!token) return '';
  return [token.start, token.query, filtered.join('\u0000')].join('\u0001');
}

export function useReferenceCompletion({
  files,
  value,
  setValue,
  disabled,
}: UseReferenceCompletionOptions): UseReferenceCompletionResult {
  const [inputKey, setInputKey] = useState(0);
  const [dismissedValue, setDismissedValue] = useState<string | null>(null);

  const token = findReferenceToken(value);
  const filtered = token ? filterFiles(files, token.query) : [];
  const showSuggestions = token !== null && filtered.length > 0 && dismissedValue !== value;
  const selectionKey = buildSelectionKey(token, filtered);
  const { effectiveSelectedIndex, latestRef, moveSelection } = useCompletionSelection<LatestReferenceState>({
    value,
    token,
    selectionKey,
    itemCount: filtered.length,
    filtered,
  });

  useInput(
    (_input, key) => {
      const latest = latestRef.current;
      if (!latest?.token || latest.filtered.length === 0) return;

      if (key.upArrow) {
        moveSelection(latest, -1);
        return;
      }
      if (key.downArrow) {
        moveSelection(latest, 1);
        return;
      }
      if (key.tab || key.return) {
        const selected = latest.filtered[latest.effectiveSelectedIndex];
        if (selected) {
          const nextValue = completeToken(latest.value, latest.token, selected);
          setValue(nextValue);
          setDismissedValue(nextValue);
          setInputKey((k) => k + 1);
        }
        return;
      }
      if (key.escape) {
        setDismissedValue(latest.value);
      }
    },
    { isActive: showSuggestions && !disabled },
  );

  return {
    filtered,
    selectedIndex: effectiveSelectedIndex,
    showSuggestions,
    inputKey,
  };
}
