import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SPLITBRIEF_DIR } from '../../core/paths.js';
import { writeSecureFile } from '../../lib/fs.js';
import { isENOENT } from '../../lib/process/errors.js';
import { redactSecrets } from '../../utils/redact.js';
import { warnError } from '../../lib/warn.js';
import { inputHistoryStore, normalizeInputHistoryEntries } from './input-history.js';

const DEBOUNCE_MS = 300;
let activeTeardown: (() => void) | null = null;

function historyFile(): string {
  return join(homedir(), SPLITBRIEF_DIR, 'history');
}

function saveHistoryToDisk(entries: readonly string[]): void {
  const redacted = entries.map((entry) => redactSecrets(entry));
  writeSecureFile(historyFile(), normalizeInputHistoryEntries(redacted).join('\n'));
}

export function loadHistoryFromDisk(): string[] {
  try {
    const content = readFileSync(historyFile(), 'utf-8');
    return normalizeInputHistoryEntries(
      content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    );
  } catch (err) {
    if (isENOENT(err)) return [];
    warnError('input-history: failed to load', err);
    return [];
  }
}

export function installHistoryPersistence(): () => void {
  if (activeTeardown) activeTeardown();

  inputHistoryStore.hydrate(loadHistoryFromDisk());

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingEntries: string[] | null = null;
  let disposed = false;

  const flushPendingWrite = () => {
    if (pendingEntries === null) return;
    const entries = pendingEntries;
    pendingEntries = null;
    try {
      saveHistoryToDisk(entries);
    } catch (err) {
      warnError('input-history: failed to save', err);
    }
  };

  const scheduleDebouncedWrite = (entries: string[]) => {
    pendingEntries = [...entries];
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      flushPendingWrite();
    }, DEBOUNCE_MS);
  };

  let persistedEntries = inputHistoryStore.get().entries;
  const unsubscribe = inputHistoryStore.subscribe(() => {
    const entries = inputHistoryStore.get().entries;
    if (entries === persistedEntries) return;
    persistedEntries = entries;
    scheduleDebouncedWrite(entries);
  });

  const teardown = () => {
    if (disposed) return;
    disposed = true;
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    flushPendingWrite();
    unsubscribe();
    if (activeTeardown === teardown) activeTeardown = null;
  };

  activeTeardown = teardown;
  return teardown;
}
