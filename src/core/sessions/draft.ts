import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  confinedExists,
  confinedReadFile,
  confinedUnlinkSync,
  confinedWriteFile,
} from '../../lib/confined-fs.js';
import { sanitizePasteBody } from '../../lib/terminal/filtered-stdin/paste.js';
import { draftLength, normalizeDraftDocument } from '../composer/document.js';
import { sessionDir } from '../paths.js';
import { DraftDocumentSchema, type DraftDocument } from '../schemas/draft-document.js';
import type { SessionRef } from '../types/session-ref.js';
import { assertSessionDirConfined, resolveSessionFilePath } from './confinement.js';
import { sessionError } from './errors.js';
import { sessionRelativePath } from './ownership-marker.js';

const DRAFT_FILE = 'draft.json';

function draftPath(ref: SessionRef): string {
  assertSessionDirConfined(ref.projectDir, ref.sessionId);
  const directory = sessionDir(ref.projectDir, ref.sessionId);
  // The confinement check resolves against the session directory, so the file must be named
  // relative to it — passing a project-relative path would double it whenever projectDir itself
  // is relative and read as an escape.
  if (existsSync(directory)) resolveSessionFilePath(DRAFT_FILE, directory);
  return relative(ref.projectDir, join(directory, DRAFT_FILE));
}

export function readSessionDraft(ref: SessionRef): DraftDocument | null {
  const raw = confinedReadFile(ref.projectDir, draftPath(ref));
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  const document = DraftDocumentSchema.parse(parsed);
  // A reopened run sends its restored draft as the steer on a bare ⏎, so key bytes an earlier
  // build saved as text do not come back: the draft keeps only what a paste may carry.
  return normalizeDraftDocument({
    version: 1,
    parts: document.parts.map((part) =>
      part.kind === 'text' ? { ...part, text: sanitizePasteBody(part.text) } : part,
    ),
  });
}

/**
 * A cleared draft leaves no file. An old file that cannot be removed throws its own error, so a
 * caller never holds an empty composer for it.
 */
export function writeSessionDraft(ref: SessionRef, document: DraftDocument): void {
  const relativePath = sessionRelativePath(ref.sessionId, DRAFT_FILE);
  let path: string;
  try {
    path = draftPath(ref);
    if (draftLength(document) > 0) {
      confinedWriteFile(ref.projectDir, path, JSON.stringify(DraftDocumentSchema.parse(document)));
      return;
    }
    if (!confinedExists(ref.projectDir, path)) return;
  } catch (error) {
    throw sessionError.draftNotSaved(relativePath, error);
  }
  try {
    confinedUnlinkSync(ref.projectDir, path);
  } catch (error) {
    throw sessionError.draftNotRemoved(relativePath, error);
  }
}
