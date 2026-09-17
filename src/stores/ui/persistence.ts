import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createDraftDocument } from '../../core/composer/document.js';
import { SPLITBRIEF_DIR } from '../../core/paths.js';
import { type DraftDocument, DraftDocumentSchema } from '../../core/schemas/draft-document.js';
import { writeSecureFile } from '../../lib/fs.js';
import { isENOENT } from '../../lib/process/errors.js';
import { redactSecrets } from '../../utils/redact.js';
import { warnError } from '../../lib/warn.js';
import { inputHistoryStore, normalizeInputHistoryEntries } from './input-history.js';

const DEBOUNCE_MS = 300;
const ENVELOPE_PREFIX = '{"version":';
let activeTeardown: (() => void) | null = null;

const HistoryEnvelopeSchema = z.object({
  version: z.literal(1),
  entries: z.array(DraftDocumentSchema),
});

function historyFile(): string {
  return join(homedir(), SPLITBRIEF_DIR, 'history');
}

function redactDocument(document: DraftDocument): DraftDocument {
  return {
    version: 1,
    parts: document.parts.map((part) =>
      part.kind === 'text' ? { kind: 'text', text: redactSecrets(part.text) } : part,
    ),
  };
}

function saveHistoryToDisk(entries: readonly DraftDocument[]): void {
  const envelope = {
    version: 1,
    entries: normalizeInputHistoryEntries(entries.map(redactDocument)),
  };
  writeSecureFile(historyFile(), JSON.stringify(envelope));
}

function parseHistory(content: string): DraftDocument[] {
  if (!content.startsWith(ENVELOPE_PREFIX)) {
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(createDraftDocument);
  }
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (err) {
    warnError('input-history: ignored a malformed history file', err);
    return [];
  }
  const envelope = HistoryEnvelopeSchema.safeParse(json);
  if (!envelope.success) {
    warnError('input-history: ignored a malformed history file', envelope.error);
    return [];
  }
  return envelope.data.entries;
}

export function loadHistoryFromDisk(): DraftDocument[] {
  try {
    return normalizeInputHistoryEntries(parseHistory(readFileSync(historyFile(), 'utf-8')));
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
  let pendingEntries: DraftDocument[] | null = null;
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

  const scheduleDebouncedWrite = (entries: DraftDocument[]) => {
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
