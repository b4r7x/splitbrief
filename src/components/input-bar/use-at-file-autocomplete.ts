import { useEffect, useState } from 'react';
import { useInput } from 'ink';
import { Fzf, type FzfResultItem } from 'fzf';
import { rotateIndex } from '../pickers/picker-utils.js';

const MAX_RESULTS = 50;

interface UseAtFileAutocompleteOptions {
  files: string[];
  value: string;
  setValue: (value: string) => void;
  disabled?: boolean | undefined;
}

interface UseAtFileAutocompleteResult {
  filtered: string[];
  selectedIndex: number;
  showSuggestions: boolean;
  atQuery: string;
}

interface AtToken {
  start: number;
  query: string;
}

function isTokenBoundary(value: string, index: number): boolean {
  return index === 0 || value[index - 1] === ' ' || value[index - 1] === '\n';
}

export function findAtToken(value: string): AtToken | null {
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

function completeToken(value: string, token: AtToken, selected: string): string {
  return `${value.slice(0, token.start)}@${selected}${value.slice(token.start + token.query.length + 1)}`;
}

export function useAtFileAutocomplete({
  files,
  value,
  setValue,
  disabled,
}: UseAtFileAutocompleteOptions): UseAtFileAutocompleteResult {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissedValue, setDismissedValue] = useState<string | null>(null);

  const token = findAtToken(value);
  const filtered = token ? filterFiles(files, token.query) : [];
  const showSuggestions = token !== null && filtered.length > 0 && dismissedValue !== value;
  const effectiveSelectedIndex = Math.min(selectedIndex, Math.max(0, filtered.length - 1));

  useEffect(() => {
    setSelectedIndex(0);
  }, [token?.query]);

  useInput(
    (_input, key) => {
      if (!token || filtered.length === 0) return;

      if (key.upArrow) {
        setSelectedIndex(rotateIndex(effectiveSelectedIndex, filtered.length, -1));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex(rotateIndex(effectiveSelectedIndex, filtered.length, 1));
        return;
      }
      if (key.tab || key.return) {
        const selected = filtered[effectiveSelectedIndex];
        if (selected) {
          const nextValue = completeToken(value, token, selected);
          setValue(nextValue);
          setDismissedValue(nextValue);
        }
        return;
      }
      if (key.escape) {
        setDismissedValue(value);
      }
    },
    { isActive: showSuggestions && !disabled },
  );

  return {
    filtered,
    selectedIndex: effectiveSelectedIndex,
    showSuggestions,
    atQuery: token?.query ?? '',
  };
}
