import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DIPTYCH_DIR } from '../../core/paths.js';
import { writeSecureFile } from '../../lib/fs.js';
import { warnError } from '../../lib/warn.js';
import { inputHistoryStore, MAX_INPUT_HISTORY } from './input-history.js';

const HISTORY_FILE = join(homedir(), DIPTYCH_DIR, 'history');
const DEBOUNCE_MS = 300;

export function loadHistoryFromDisk(): string[] {
  try {
    const content = readFileSync(HISTORY_FILE, 'utf-8');
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .slice(0, MAX_INPUT_HISTORY);
  } catch {
    return [];
  }
}

export function installHistoryPersistence(): () => void {
  inputHistoryStore.hydrate(loadHistoryFromDisk());

  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleDebouncedWrite = (entries: string[]) => {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        writeSecureFile(HISTORY_FILE, entries.join('\n'));
      } catch (err) {
        warnError('input-history: failed to save', err);
      }
    }, DEBOUNCE_MS);
  };

  const unsubscribe = inputHistoryStore.subscribe(() => {
    scheduleDebouncedWrite(inputHistoryStore.get().entries);
  });

  return () => {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    unsubscribe();
  };
}
