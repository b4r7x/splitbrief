import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { confinedReadFile, confinedWriteFile } from '../../lib/confined-fs.js';
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
  return DraftDocumentSchema.parse(parsed);
}

export function writeSessionDraft(ref: SessionRef, document: DraftDocument): void {
  confinedWriteFile(
    ref.projectDir,
    draftPath(ref),
    JSON.stringify(DraftDocumentSchema.parse(document)),
  );
}
