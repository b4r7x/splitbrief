import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { confinedReadFile, confinedWriteFile } from '../../lib/confined-fs.js';
import { sanitizePasteBody } from '../../lib/terminal/filtered-stdin/paste.js';
import { normalizeDraftDocument } from '../composer/document.js';
import { sessionDir } from '../paths.js';
import { DraftDocumentSchema, type DraftDocument } from '../schemas/draft-document.js';
import type { SessionRef } from '../types/session-ref.js';
import { assertSessionDirConfined, resolveSessionFilePath } from './confinement.js';

function draftPath(ref: SessionRef): string {
  assertSessionDirConfined(ref.projectDir, ref.sessionId);
  const directory = sessionDir(ref.projectDir, ref.sessionId);
  // The confinement check resolves against the session directory, so the file must be named
  // relative to it — passing a project-relative path would double it whenever projectDir itself
  // is relative and read as an escape.
  if (existsSync(directory)) resolveSessionFilePath('draft.json', directory);
  return relative(ref.projectDir, join(directory, 'draft.json'));
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

export function writeSessionDraft(ref: SessionRef, document: DraftDocument): void {
  confinedWriteFile(
    ref.projectDir,
    draftPath(ref),
    JSON.stringify(DraftDocumentSchema.parse(document)),
  );
}
